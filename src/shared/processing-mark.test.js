/**
 * 「正在处理」标记的生命周期单测 —— 钉死四种形态：
 * 同步立即摘 / hold 等延续 / transfer 移交 / 上限兜底，外加「release 只发一次」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessingMark, MARK_MAX_MS } from './processing-mark.js';

/** 每个用例一个可控的标记：release 记调用，cap 定时器手动触发 */
function make(over = {}) {
  const calls = [];
  let capFn = null;
  let capMs = null;
  let cleared = 0;
  const mark = createProcessingMark({
    messageId: 'om_1',
    reactionId: 'or_1',
    release: async (opts) => {
      calls.push(opts?.quiet ? 'release-quiet' : 'release');
    },
    setTimer: (fn, ms) => {
      capFn = fn;
      capMs = ms;
      return { unref() {} };
    },
    clearTimer: () => {
      cleared += 1;
    },
    ...over,
  });
  return {
    mark,
    calls,
    fireCap: () => capFn?.(),
    capMs: () => capMs,
    cleared: () => cleared,
  };
}

test('契约：messageId / reactionId 原样带出（跨进程移交的 payload 靠它）', () => {
  const { mark } = make();
  assert.equal(mark.messageId, 'om_1');
  assert.equal(mark.reactionId, 'or_1');
  assert.equal(mark.transferred, false);
});

test('无延续：settle 时立即摘（同步流程的原行为不变）', async () => {
  const { mark, calls } = make();
  await mark.settle();
  assert.deepEqual(calls, ['release']);
});

test('hold：延续落地前不摘；settle 返回的 promise 等它落地', async () => {
  const { mark, calls } = make();
  let finish = null;
  mark.hold(new Promise((r) => (finish = r)));
  const settling = mark.settle();
  await new Promise((r) => setImmediate(r)); // 让 settle 的微任务排空
  assert.deepEqual(calls, [], '延续没完，标记还在');
  finish();
  await settling;
  assert.deepEqual(calls, ['release']);
});

test('hold 多个延续：全部落地才摘', async () => {
  const { mark, calls } = make();
  let f1 = null;
  let f2 = null;
  mark.hold(new Promise((r) => (f1 = r)));
  mark.hold(new Promise((r) => (f2 = r)));
  const settling = mark.settle();
  f1();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [], '还有一个没落地');
  f2();
  await settling;
  assert.deepEqual(calls, ['release']);
});

test('延续 reject 也算落地（失败原因由延续自己回告，标记不陪葬）', async () => {
  const { mark, calls } = make();
  let reject = null;
  mark.hold(new Promise((_r, rj) => (reject = rj)));
  const settling = mark.settle();
  reject(new Error('boom'));
  await settling;
  assert.deepEqual(calls, ['release']);
});

test('transfer：本进程不摘（远端 web 会在终态答复后摘）', async () => {
  const { mark, calls } = make();
  mark.transfer();
  await mark.settle();
  assert.equal(mark.transferred, true);
  assert.deepEqual(calls, [], '移交后本进程不得摘 —— 摘早了就是这次要修的 bug');
});

test('transfer 后的兜底：上限触发时静默摘（远端没摘走的最后防线）', async () => {
  const { mark, calls, fireCap } = make();
  mark.transfer();
  await mark.settle();
  fireCap();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['release-quiet']);
});

test('上限兜住永不落地的延续（warn 留痕而不是永远挂着）', async () => {
  const { mark, calls, fireCap } = make();
  mark.hold(new Promise(() => {})); // 永远不 resolve
  const settling = mark.settle();
  fireCap();
  await settling;
  assert.deepEqual(calls, ['release']);
});

test('已摘之后 hold / transfer 都是 no-op，release 只发一次', async () => {
  const { mark, calls } = make();
  await mark.settle();
  mark.hold(Promise.resolve());
  mark.transfer();
  await mark.settle();
  assert.deepEqual(calls, ['release']);
});

test('settle 后重复 settle 幂等（不会重复摘）', async () => {
  const { mark, calls } = make();
  await mark.settle();
  await mark.settle();
  assert.deepEqual(calls, ['release']);
});

test('没贴上表情（release=null）：各形态都不炸', async () => {
  const { mark } = make({ reactionId: '', release: null });
  mark.hold(Promise.resolve());
  await mark.settle();
  mark.transfer();
  await mark.settle();
  assert.equal(mark.reactionId, '');
});

test('默认上限 = MARK_MAX_MS（15 分钟；只对有延续/已移交的标记武装）', () => {
  const { mark, capMs } = make();
  mark.hold(new Promise(() => {}));
  assert.equal(capMs(), MARK_MAX_MS);
});

test('同步流程（无 hold / 无移交）不装上限定时器 —— 长跑任务不该被 15 分钟误摘', async () => {
  const { mark, capMs } = make();
  await mark.settle();
  assert.equal(capMs(), null);
});

test('正常 release 会清掉上限定时器（不留悬空定时器）', async () => {
  const { mark, cleared } = make();
  mark.hold(Promise.resolve()); // arm 一个定时器
  await mark.settle();
  assert.equal(cleared(), 1);
});
