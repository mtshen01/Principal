/**
 * heldMsgs（插话持有缓冲）单测。
 * 语义：插话消息先存服务端 run.heldMsgs（可撤回）；flush 时按序推进 SDK 输入流。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  holdMsg,
  withdrawHeldMsg,
  flushHeldMsgs,
  consumeHeldMsgs,
  stopRun,
  enqueueFollowUp,
  listFollowUps,
  clearFollowUps,
  steerQueuedNow,
} from './runs.js';

// 最小 run 假件：绕过 createRun（其看门狗 setInterval 会挂住测试进程）
function fakeRun(input) {
  return {
    id: 'run_test',
    status: 'running',
    heldMsgs: [],
    _input: input || null,
    subscribers: new Set(),
    updatedAt: 0,
    lastProgressAt: 0,
  };
}

test('holdMsg 追加并返回 msgId；withdrawHeldMsg 移除，重复撤回返回 false', () => {
  const run = fakeRun();
  const id1 = holdMsg(run, '第一条');
  const id2 = holdMsg(run, '第二条');
  assert.equal(run.heldMsgs.length, 2);
  assert.ok(id1 && id2 && id1 !== id2);
  assert.equal(withdrawHeldMsg(run, id1), true);
  assert.deepEqual(run.heldMsgs.map((m) => m.text), ['第二条']);
  assert.equal(withdrawHeldMsg(run, id1), false); // 已移除 → 撤回失败
});

test('holdMsg：附件元数据随持有消息保留（consume 原样取出；无附件不带字段）', () => {
  const run = fakeRun();
  const attach = [{ path: 'C:/tmp/a.png', name: 'a.png' }];
  holdMsg(run, '看图', attach);
  holdMsg(run, '纯文本');
  const msgs = consumeHeldMsgs(run, 'step');
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0].attachments, attach);
  assert.equal(msgs[0].text, '看图');
  assert.ok(!('attachments' in msgs[1]), '没附件就不带字段');
});

test('flushHeldMsgs 按序推进 _input 并清空持有区，返回已消费 id', () => {
  const pushed = [];
  const run = fakeRun({ push: (t) => (pushed.push(t), true) });
  const id1 = holdMsg(run, 'a');
  const id2 = holdMsg(run, 'b');
  const ids = flushHeldMsgs(run);
  assert.deepEqual(pushed, ['a', 'b']);
  assert.deepEqual(ids, [id1, id2]);
  assert.equal(run.heldMsgs.length, 0);
});

test('flushHeldMsgs 无 _input 时不消费（判档窗口内消息继续持有）', () => {
  const run = fakeRun(null);
  holdMsg(run, 'a');
  assert.deepEqual(flushHeldMsgs(run), []);
  assert.equal(run.heldMsgs.length, 1);
});

test('flushHeldMsgs push 失败的消息保留在持有区（输入流已关的窄窗口）', () => {
  const run = fakeRun({ push: () => false });
  holdMsg(run, 'a');
  assert.deepEqual(flushHeldMsgs(run), []);
  assert.equal(run.heldMsgs.length, 1);
});

test('consumeHeldMsgs 取空持有区并返回消息（额度用尽续跑打包用）', () => {
  const run = fakeRun();
  holdMsg(run, 'x');
  holdMsg(run, 'y');
  const msgs = consumeHeldMsgs(run);
  assert.deepEqual(msgs.map((m) => m.text), ['x', 'y']);
  assert.equal(run.heldMsgs.length, 0);
  assert.deepEqual(consumeHeldMsgs(run), []);
});

test('consumeHeldMsgs(run, "step")：步边界 steer 取走（P1-10），consumed 广播照发', () => {
  const frames = [];
  const run = fakeRun();
  run.subscribers = new Set([{ write: (s) => (frames.push(String(s)), true) }]);
  holdMsg(run, 's1');
  holdMsg(run, 's2');
  const msgs = consumeHeldMsgs(run, 'step');
  assert.deepEqual(msgs.map((m) => m.text), ['s1', 's2']);
  assert.equal(run.heldMsgs.length, 0, '取走后持有区清空');
  const consumedFrames = frames.filter((s) => s.startsWith('event: consumed'));
  assert.equal(consumedFrames.length, 1);
  assert.ok(frames.some((s) => s.includes('"hm_')), 'data 帧带 msgIds（前端据此清排队态）');
});

test('stopRun 终结：done 事件附带 unsent（未消费持有消息）并清空持有区', async () => {
  const events = [];
  const res = { write: (s) => (events.push(s), true), end: () => {} };
  const run = {
    id: 'run_test2',
    status: 'running',
    text: '',
    heldMsgs: [],
    _input: null,
    pending: null,
    pendingQueue: [],
    waiting: false,
    waitingSince: 0,
    waitedMs: 0,
    abortController: new AbortController(),
    subscribers: new Set([res]),
    updatedAt: 0,
    lastProgressAt: 0,
    _watchdog: null,
  };
  const id = holdMsg(run, '未发出的插话');
  stopRun(run, '已手动停止');
  const doneIdx = events.findIndex((s) => s.includes('event: done'));
  const payload = JSON.parse(events[doneIdx + 1].replace(/^data: /, ''));
  assert.deepEqual(payload.unsent, [id]);
  assert.equal(run.heldMsgs.length, 0);
});

// ==== queue-first：「立即发送」（steerQueuedNow）与终结回队 ====

/** 最小 run 假件（带 convId/能力位/待答队列），供 steerQueuedNow 与终结路径用例 */
function queuedRun(convId, opts = {}) {
  const { _input = null, ...caps } = opts;
  return {
    id: 'run_q_' + Math.random().toString(36).slice(2, 8),
    status: 'running',
    convId,
    text: '',
    heldMsgs: [],
    pending: null,
    pendingQueue: [],
    subscribers: new Set(),
    capabilities: { steer: true, steerMode: 'turn', followUp: true, ...caps },
    _input,
    updatedAt: 0,
    lastProgressAt: 0,
    _watchdog: null,
  };
}

test('steerQueuedNow（turn）：出队 → 持有（id 不变）→ flush + interrupt；consumed 广播带同 id', () => {
  clearFollowUps();
  const pushed = [];
  const frames = [];
  let interrupted = 0;
  const run = queuedRun('c_sq_turn', {
    _input: { push: (t) => (pushed.push(t), true), interrupt: () => (interrupted++, Promise.resolve()) },
  });
  run.subscribers = new Set([{ write: (s) => (frames.push(String(s)), true) }]);
  const id = enqueueFollowUp('c_sq_turn', { text: '立即发我' });

  const r = steerQueuedNow('c_sq_turn', id, run);
  assert.equal(r.ok, true);
  assert.deepEqual(pushed, ['立即发我'], 'flush 必须把内容推进 SDK 输入流');
  assert.equal(interrupted, 1, '打断当前轮，让 SDK 尽快读入');
  assert.equal(run.heldMsgs.length, 0);
  assert.equal(listFollowUps('c_sq_turn').length, 0, '转换后不再留在队列');
  assert.ok(
    frames.some((s) => s.startsWith('event: consumed')) && frames.some((s) => s.includes(id)),
    'consumed 事件必须带原 fu id——前端卡片据此上屏',
  );
});

test('steerQueuedNow（turn）：输入流未就绪（判档窗口）→ not_ready，队列与持有区都不动', () => {
  clearFollowUps();
  const run = queuedRun('c_sq_ready'); // _input = null
  const id = enqueueFollowUp('c_sq_ready', { text: '先别动' });

  const r = steerQueuedNow('c_sq_ready', id, run);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_ready');
  assert.deepEqual(listFollowUps('c_sq_ready').map((m) => m.id), [id], '拒绝时不得动队列');
  assert.equal(run.heldMsgs.length, 0);
});

test('steerQueuedNow（turn）：输入流已关闭 → input_closed，原位置回队、id 不变、无持有残影', () => {
  clearFollowUps();
  const run = queuedRun('c_sq_roll', { _input: { push: () => false, interrupt: () => Promise.resolve() } });
  const a = enqueueFollowUp('c_sq_roll', { text: '甲', at: 1 });
  const b = enqueueFollowUp('c_sq_roll', { text: '乙', at: 2 });
  const c = enqueueFollowUp('c_sq_roll', { text: '丙', at: 3 });

  const r = steerQueuedNow('c_sq_roll', b, run);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'input_closed');
  assert.deepEqual(listFollowUps('c_sq_roll').map((m) => m.id), [a, b, c], '回滚必须回到原位置');
  assert.equal(run.heldMsgs.length, 0, '回滚不得留持有区残影');
});

test('steerQueuedNow（step）：出队进持有区（id/origin 复用），不消费——由步边界取走', () => {
  clearFollowUps();
  const run = queuedRun('c_sq_step', { steerMode: 'step' });
  const id = enqueueFollowUp('c_sq_step', { text: '插话' });

  const r = steerQueuedNow('c_sq_step', id, run);
  assert.equal(r.ok, true);
  assert.deepEqual(run.heldMsgs.map((m) => [m.id, m.text, m.origin]), [[id, '插话', 'queue']]);
  assert.equal(listFollowUps('c_sq_step').length, 0);
});

test('终结回队：origin=queue 的未消费持有项回到队列（id 不变、不进 unsent，防 conv-notify 双投递）', () => {
  clearFollowUps();
  const events = [];
  const res = { write: (s) => (events.push(String(s)), true), end: () => {} };
  const run = queuedRun('c_sq_settle', { steerMode: 'step' });
  run.abortController = new AbortController();
  run.subscribers = new Set([res]);
  const a = enqueueFollowUp('c_sq_settle', { text: '甲', at: 1 });
  const b = enqueueFollowUp('c_sq_settle', { text: '乙', at: 2 });
  assert.equal(steerQueuedNow('c_sq_settle', b, run).ok, true, 'step 模式先转进持有区');

  stopRun(run, '已手动停止');
  const doneIdx = events.findIndex((s) => s.includes('event: done'));
  const payload = JSON.parse(events[doneIdx + 1].replace(/^data: /, ''));
  assert.equal(payload.unsent, undefined, '回队项不得标 unsent');
  assert.deepEqual(listFollowUps('c_sq_settle').map((m) => m.id), [a, b], '按 at 序并回、id 不变');
  assert.ok(
    events.some((s) => s.startsWith('event: steer_requeued')) && events.some((s) => s.includes(b)),
    '广播 steer_requeued 供前端把卡片从「发送中」复位',
  );
});
