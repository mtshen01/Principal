/**
 * tracking-freeform feature 的 handle 单测 —— 只钉「正在处理」标记：
 * 数据查询要后台跑几十秒到几分钟，结果（或失败回告）发出之前不能摘标记
 *（2026-10-14 反馈的 bug 类别：表情出现一下就消失、机器人其实还在查）。
 *
 * startFreeformQuery 经 deps 注入替身：真实路径要 LLM + 子进程 + 飞书三方（与 feature.test.js 同一表态）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import feature from './freeform.js';

function ctxOf(text) {
  const replies = [];
  const held = [];
  return {
    replies,
    held,
    ctx: {
      user: { id: 'ou_1' },
      text,
      sessionKey: 'oc_1',
      reply: async (t) => replies.push(t),
      meta: { processing: { hold: (p) => held.push(p) } },
    },
  };
}

test('数据查询：后台分析还没落地 → 标记 hold 到结果发出（done 承诺）', async () => {
  const { ctx, held } = ctxOf('帮我查数据: 上周新增用户里有多少下单了');
  const done = Promise.resolve();
  await feature.handle(ctx, null, {
    startFreeformQuery: async (a) => {
      assert.equal(a.text, '上周新增用户里有多少下单了', '前缀已剥离');
      return { started: true, done };
    },
  });
  assert.equal(held.length, 1, '标记必须挂到后台分析 —— 结果没出就不许摘');
  assert.equal(held[0], done);
});

test('被限流/没排上队：没有后台延续 → 不 hold，只回错误文案', async () => {
  const { ctx, held, replies } = ctxOf('帮我查数据: x');
  await feature.handle(ctx, null, {
    startFreeformQuery: async () => ({ started: false, error: '查得有点密，稍等一下再试' }),
  });
  assert.equal(held.length, 0);
  assert.equal(replies[0], '查得有点密，稍等一下再试');
});

test('只发前缀：追问，不启动查询也不 hold', async () => {
  const { ctx, held, replies } = ctxOf('帮我查数据:');
  let started = false;
  await feature.handle(ctx, null, {
    startFreeformQuery: async () => {
      started = true;
      return { started: true };
    },
  });
  assert.equal(started, false);
  assert.equal(held.length, 0);
  assert.match(replies[0], /想查什么数据/);
});
