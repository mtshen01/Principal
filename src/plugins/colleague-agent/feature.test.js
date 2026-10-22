/**
 * dispatch feature 单测。它只做一件事：名册内的同事消息交给 relay，否则 PASS 回落。
 * 群聊 @ 过滤不在这里 —— 那是 feishu 入口的事（feature 收到的已经是过滤后的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import feature, { matchColleague } from './feature.js';
import { PASS } from '../../app/signals.js';

test('feature 契约：match 全接（P4），不再靠 intents 白名单', () => {
  assert.equal(feature.name, 'colleague-agent');
  assert.equal(feature.permission, 'any');
  assert.deepEqual(feature.intents, [], 'intents 白名单退役：match 先于意图分类生效');
  assert.equal(typeof feature.match, 'function');
  assert.equal(typeof feature.handle, 'function');
  assert.equal(feature.hasPending, undefined, '选择卡已下线，不该再有待归属态');
});

test('match：名册内 → true；非名册/缺 openId → false（陌生人照旧走分类 → feedback）', () => {
  const colleagues = [{ id: 'cl_1', name: '张三', role: 'backend', feishuOpenId: 'ou_1' }];
  const deps = { getColleagues: () => colleagues };
  assert.equal(matchColleague({ user: { id: 'ou_1' } }, deps), true);
  assert.equal(matchColleague({ user: { id: 'ou_x' } }, deps), false);
  assert.equal(matchColleague({ user: {} }, deps), false);
  assert.equal(matchColleague(undefined, deps), false);
});

test('match：feature.match 用真实名册判定（缺参数不炸）', () => {
  assert.equal(typeof feature.match({ user: { id: 'ou_不存在' } }), 'boolean');
});

test('名册内：交给 relay 接管，不回任何话（回复由 web 进程的 agent 发）', async () => {
  let got = null;
  let replied = false;
  const r = await feature.handle(
    { user: { id: 'ou_1' }, text: '接口给你了', reply: async () => (replied = true) },
    null,
    { relay: async (m) => ((got = m), true) },
  );
  assert.notEqual(r, PASS);
  assert.equal(got.openId, 'ou_1');
  assert.equal(got.text, '接口给你了');
  assert.equal(replied, false, 'ACK 由 web 侧按需发（正常路径不发，等 agent 真回复）');
});

test('handle 透传 chatId / chatType（P4 送达目标 + 2026-10-13 回复路由）', async () => {
  let got = null;
  await feature.handle(
    { user: { id: 'ou_1' }, text: 'x', sessionKey: 'oc_9', meta: { chatType: 'group' } },
    null,
    { relay: async (m) => ((got = m), true) },
  );
  assert.equal(got.chatId, 'oc_9');
  assert.equal(got.chatType, 'group');
});

test('handle：meta.chatType 缺失（卡片等非消息路径）→ 归空串，下游降级私聊', async () => {
  let got = null;
  await feature.handle({ user: { id: 'ou_1' }, text: 'x', sessionKey: 'oc_9' }, null, {
    relay: async (m) => ((got = m), true),
  });
  assert.equal(got.chatType, '');
});

// 2026-10-14：「正在处理」标记的摘除凭据随消息移交 web —— agent 的答复在 web 侧发出，
// 标记也该在那时摘（飞书侧 settle 看到 transferred 就不再摘；见 shared/processing-mark.js）。
test('handle：接管即移交处理中标记，并把摘除凭据（messageId / reactionId）带进 payload', async () => {
  let got = null;
  let transferred = 0;
  const processing = { messageId: 'om_9', reactionId: 'or_9', transfer: () => transferred++ };
  await feature.handle(
    { user: { id: 'ou_1' }, text: 'x', sessionKey: 'oc_9', meta: { chatType: 'group', processing } },
    null,
    { relay: async (m) => ((got = m), true) },
  );
  assert.equal(got.feishuMessageId, 'om_9');
  assert.equal(got.reactionId, 'or_9');
  assert.equal(transferred, 1, '接管了才移交 —— 摘除责任跟着回复走');
});

test('handle：没有处理中标记（未贴表情 / 非飞书渠道）→ 凭据归空串、不炸', async () => {
  let got = null;
  await feature.handle({ user: { id: 'ou_1' }, text: 'x', sessionKey: 'oc_9' }, null, {
    relay: async (m) => ((got = m), true),
  });
  assert.equal(got.feishuMessageId, '');
  assert.equal(got.reactionId, '');
});

test('handle：不接管（relay 返回 false → PASS 回落）→ 不移交标记，留给入口按常规收尾', async () => {
  let transferred = 0;
  const processing = { messageId: 'om_9', reactionId: 'or_9', transfer: () => transferred++ };
  const r = await feature.handle(
    { user: { id: 'ou_1' }, text: 'x', sessionKey: 'oc_9', meta: { processing } },
    null,
    { relay: async () => false },
  );
  assert.equal(r, PASS);
  assert.equal(transferred, 0);
});

test('不在名册：返回 PASS，把消息交回 feedback', async () => {
  const r = await feature.handle({ user: { id: 'ou_x' }, text: 'x' }, null, { relay: async () => false });
  assert.equal(r, PASS);
});

test('relay 抛错：吞掉并 PASS —— 绝不能让同事的消息因为一次异常彻底消失', async () => {
  const r = await feature.handle({ user: { id: 'ou_1' }, text: 'x' }, null, {
    relay: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(r, PASS);
});
