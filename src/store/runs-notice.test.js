/**
 * 非阻塞提示卡（presentNotice / dismissNotice / drainNotices）单测。
 *
 * 语义：与阻塞审批卡（askUser/pending）刻意分开——提示卡不阻塞 run、可多张并存（用 Map），
 * 推送/收起各发一条 SSE 事件，run 终结时全部收起（前端不留悬空卡）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { presentNotice, dismissNotice, finishRun } from './runs.js';

/** 最小 run 假件 + 记录 SSE 的假订阅者；绕过 createRun（其看门狗 setInterval 会挂住测试进程） */
function fakeRun() {
  const chunks = [];
  const res = { write: (s) => (chunks.push(String(s)), true), end: () => {} };
  const run = {
    id: 'run_test',
    status: 'running',
    text: '',
    result: '',
    is_error: false,
    subtype: '',
    notices: new Map(),
    heldMsgs: [],
    pending: null,
    pendingQueue: [],
    waiting: false,
    waitingSince: 0,
    waitedMs: 0,
    _journalSeq: 0,
    _watchdog: null,
    subscribers: new Set([res]),
    updatedAt: 0,
    lastProgressAt: 0,
  };
  return { run, dump: () => chunks.join('') };
}

const parseEvents = (text) =>
  [...text.matchAll(/event: (\S+)\ndata: (.+)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));

test('presentNotice：注册进 notices 并广播 notice 事件；同 id 覆盖为一张', () => {
  const { run, dump } = fakeRun();
  presentNotice(run, { id: 'fq_1', title: '问同事：张三', body: '字段？', options: ['a', 'b'] });
  assert.equal(run.notices.size, 1);
  const evs = parseEvents(dump());
  assert.equal(evs.length, 1);
  assert.equal(evs[0].event, 'notice');
  assert.deepEqual(evs[0].data, { id: 'fq_1', kind: 'notice', title: '问同事：张三', body: '字段？', options: ['a', 'b'] });

  presentNotice(run, { id: 'fq_1', title: '改标题' });
  assert.equal(run.notices.size, 1, '同 id 覆盖，不新增');
  assert.equal(run.notices.get('fq_1').title, '改标题');
});

test('presentNotice：多张并存（Map），互不覆盖', () => {
  const { run } = fakeRun();
  presentNotice(run, { id: 'a', title: 'A' });
  presentNotice(run, { id: 'b', title: 'B' });
  assert.deepEqual([...run.notices.keys()], ['a', 'b']);
});

test('presentNotice：缺 id 或 run 时静默 no-op（提示卡是增强，不抛）', () => {
  const { run } = fakeRun();
  presentNotice(run, { title: '无 id' });
  presentNotice(null, { id: 'x' });
  assert.equal(run.notices.size, 0);
});

test('dismissNotice：移除并广播 notice-dismiss；不存在则 no-op（幂等）', () => {
  const { run, dump } = fakeRun();
  presentNotice(run, { id: 'fq_1' });
  dismissNotice(run, 'fq_1');
  assert.equal(run.notices.size, 0);
  const evs = parseEvents(dump());
  assert.equal(evs.at(-1).event, 'notice-dismiss');
  assert.deepEqual(evs.at(-1).data, { id: 'fq_1' });

  const before = dump();

  dismissNotice(run, 'fq_1'); // 再来一次
  assert.equal(dump(), before, '不存在 → 不发事件');
});

test('run 终结：drainNotices 把全部提示卡收起', () => {
  const { run, dump } = fakeRun();
  presentNotice(run, { id: 'a' });
  presentNotice(run, { id: 'b' });
  finishRun(run);
  assert.equal(run.notices.size, 0);
  const dismisses = parseEvents(dump()).filter((e) => e.event === 'notice-dismiss').map((e) => e.data.id);
  assert.deepEqual(dismisses.sort(), ['a', 'b']);
});
