/**
 * feedback feature 的 handle 单测 —— 只钉一件事：「正在处理」标记的挂载。
 * 即时应答之后还有后台分析（轻度托管）或评审流（中/完全托管）要继续，dispatch 返回时
 * 绝不能摘标记（2026-10-14 反馈的 bug 类别：表情出现一下就消失、机器人其实还在想）。
 *
 * 分析 / 评审 / 系统通知全部经 deps 注入替身：真实调用要 LLM，且 systemNotify 在 Windows
 * 会真的弹 Toast（测试不许有系统副作用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-idx-'));

const { default: feature } = await import('./index.js');
const { addBot } = await import('../../../store/settings.js');

function ctxOf() {
  const replies = [];
  const held = [];
  return {
    replies,
    held,
    ctx: {
      user: { id: 'ou_guest', role: 'guest' },
      text: '登录页白屏了',
      sessionKey: 'oc_1',
      reply: async (t) => replies.push(t),
      meta: { chatId: 'oc_1', processing: { hold: (p) => held.push(p) } },
    },
  };
}

// 先跑轻度（此刻环境里没有启用机器人 → autonomy 默认 light），再建 full 托管的跑评审分支
test('轻度托管：后台分析还没落地 → 标记 hold 到闭环回复发出', async () => {
  const { ctx, replies, held } = ctxOf();
  let finishAnalysis = null;
  const analysisDone = new Promise((r) => (finishAnalysis = r));
  await feature.handle(ctx, { intent: 'feature', body: '登录页白屏了', strong: false }, {
    analyze: async () => analysisDone,
    notify: () => {},
  });

  assert.equal(replies.length, 1, '即时应答先发出');
  assert.equal(held.length, 1, '标记必须挂到后台分析 —— 分析没完就不许摘');
  finishAnalysis();
  await held[0];
  assert.equal(replies.length, 2, '闭环回复随后发出（此时标记才允许消失）');
});

test('完全托管：评审流还没落地 → 标记同样 hold 到评审结论', async () => {
  addBot({ name: '测试机器人', platform: 'feishu', appId: 'cli_x', appSecret: 'sec', autonomy: 'full', enabled: true });
  const { ctx, held } = ctxOf();
  await feature.handle(ctx, { intent: 'feature', body: '登录页白屏了', strong: false }, {
    reviewFlow: async () => {},
    notify: () => {},
  });
  assert.equal(held.length, 1, '评审结论由 runReviewFlow 稍后发出，标记要挂到它落地');
});

test('没有标记渠道（console 等）：可选链 no-op，主流程照常', async () => {
  const replies = [];
  const ctx = {
    user: { id: 'ou_guest', role: 'guest' },
    text: '登录页白屏了',
    sessionKey: 'oc_1',
    reply: async (t) => replies.push(t),
    meta: { chatId: 'oc_1' }, // 无 processing
  };
  await feature.handle(ctx, { intent: 'feature', body: '登录页白屏了', strong: false }, {
    reviewFlow: async () => {},
    notify: () => {},
  });
  assert.equal(replies.length, 1);
});
