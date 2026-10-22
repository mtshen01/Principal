/**
 * 回复目标路由单测 —— 钉死「群聊回群、私聊回私聊、拿不到群坐标不静默」三条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyTarget } from './reply-target.js';

test('群聊：回群里 + @ 提问人（receiveId 是群 id，at 是拼好的标签）', () => {
  const t = resolveReplyTarget({ openId: 'ou_1', chatId: 'oc_g', chatType: 'group' });
  assert.equal(t.kind, 'group');
  assert.equal(t.receiveId, 'oc_g');
  assert.equal(t.at, '<at user_id="ou_1"></at> ');
});

test('私聊：回私聊、不带 at（<at> 标签发进 p2p 会渲染成怪串）', () => {
  const t = resolveReplyTarget({ openId: 'ou_1', chatId: 'oc_p', chatType: 'p2p' });
  assert.equal(t.kind, 'p2p');
  assert.equal(t.receiveId, 'ou_1');
  assert.equal(t.at, '');
});

test('chatType 缺失/未知：降级回私聊（老报文 / 字段没透传，都按 p2p 处理）', () => {
  for (const chatType of [undefined, null, '', 'GROUP']) {
    const t = resolveReplyTarget({ openId: 'ou_1', chatId: 'oc_g', chatType });
    assert.equal(t.kind, 'p2p', `chatType=${String(chatType)} 应降级 p2p`);
    assert.equal(t.receiveId, 'ou_1');
  }
});

test('群聊但 chatId 为空：降级回私聊 —— 宁可回私聊，也不能把答复扔进虚空', () => {
  const t = resolveReplyTarget({ openId: 'ou_1', chatId: '', chatType: 'group' });
  assert.equal(t.kind, 'p2p');
  assert.equal(t.receiveId, 'ou_1');
});

test('openId 不合法（注入防护）：at 归空串，但仍是一条可送达的群回复', () => {
  const t = resolveReplyTarget({ openId: 'x"><script', chatId: 'oc_g', chatType: 'group' });
  assert.equal(t.kind, 'group');
  assert.equal(t.receiveId, 'oc_g');
  assert.equal(t.at, '', 'atPrefix 的 open_id 白名单拦下拼接，不把用户内容拼进标签属性');
});

test('参数整体缺失：不抛，归出一个空的 p2p 目标（由发送侧按空 id 兜底）', () => {
  const t = resolveReplyTarget();
  assert.equal(t.kind, 'p2p');
  assert.equal(t.receiveId, '');
  assert.equal(t.at, '');
});
