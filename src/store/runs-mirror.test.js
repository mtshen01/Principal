/**
 * runs.js 落盘镜像（P1-9）单测：follow-up 队列与任务清单（plan）的 sink 通知契约
 * ——迁移序列/载荷、抛错被吞、hydrate 去重且不回调 sink、hydrateRunTodos 不覆盖已有。
 * 隔离：APP_DATA_DIR → 临时目录（与 store 基座一致；runs.js 自身不写盘）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-mirror-'));

const {
  createRun,
  finishRun,
  runTodos,
  hydrateRunTodos,
  registerRunTodosSink,
  enqueueFollowUp,
  buildFollowUpItem,
  takeFollowUps,
  cancelFollowUp,
  listFollowUps,
  hydrateFollowUps,
  listConvsWithFollowUps,
  clearFollowUps,
  registerFollowUpSink,
} = await import('./runs.js');

test.afterEach(() => {
  registerFollowUpSink(null);
  registerRunTodosSink(null);
  clearFollowUps();
});

test('follow-up sink：enqueue/cancel/take 迁移逐个通知，载荷含完整排队项快照', () => {
  const ops = [];
  registerFollowUpSink((op) => ops.push(op));
  const src = createRun();
  src.convId = 'c_sink';
  src.provider = 'openai-compat';
  src.model = 'glm';

  const id = enqueueFollowUp('c_sink', buildFollowUpItem(src, { text: '落盘消息' }));
  cancelFollowUp('c_sink', id);
  const id2 = enqueueFollowUp('c_sink', buildFollowUpItem(src, { text: '再来' }));
  takeFollowUps('c_sink');
  finishRun(src);

  assert.deepEqual(ops.map((o) => o.type), ['enqueue', 'cancel', 'enqueue', 'take']);
  assert.equal(ops[0].convId, 'c_sink');
  assert.equal(ops[0].item.id, id);
  assert.equal(ops[0].item.text, '落盘消息');
  assert.equal(ops[0].item.provider, 'openai-compat', '起跑快照随 sink 原样携带');
  assert.equal(ops[1].id, id);
  assert.equal(ops[2].item.id, id2);
  assert.equal(ops[3].convId, 'c_sink');
  // 空 take / 撤回不存在项：不通知（no-op 不该产生落盘动作）
  takeFollowUps('c_sink');
  cancelFollowUp('c_sink', 'fu_ghost');
  assert.equal(ops.length, 4);
});

test('follow-up sink 抛错被吞：入队/排空主链不受影响', () => {
  registerFollowUpSink(() => {
    throw new Error('disk full');
  });
  const src = createRun();
  src.convId = 'c_boom';
  assert.doesNotThrow(() => enqueueFollowUp('c_boom', buildFollowUpItem(src, { text: 'x' })));
  assert.equal(listFollowUps('c_boom').length, 1, '内存队列照常');
  assert.doesNotThrow(() => takeFollowUps('c_boom'));
  finishRun(src);
});

test('hydrateFollowUps：并回内存 + 按 id 去重 + 不回调 sink；listConvsWithFollowUps 反映队列', () => {
  const ops = [];
  registerFollowUpSink((op) => ops.push(op));
  const n = hydrateFollowUps('c_hyd', [
    { id: 'fu_1', text: 'a', provider: 'openai-compat' },
    { id: 'fu_2', text: 'b' },
  ]);
  assert.equal(n, 2);
  assert.equal(ops.length, 0, 'hydrate 不回调 sink（盘上数据不回写）');
  hydrateFollowUps('c_hyd', [
    { id: 'fu_1', text: '重复投递' },
    { id: 'fu_3', text: 'c' },
  ]);
  assert.deepEqual(listFollowUps('c_hyd').map((m) => m.text), ['a', 'b', 'c']);
  assert.deepEqual(listConvsWithFollowUps(), ['c_hyd']);
  assert.equal(hydrateFollowUps('', [{ id: 'x' }]), 0);
  assert.equal(hydrateFollowUps('c_hyd', 'junk'), 0);
  assert.equal(hydrateFollowUps('c_none', [{ nope: true }]), 0, '无 id 条目被跳过');
  assert.deepEqual(listConvsWithFollowUps(), ['c_hyd']);
});

test('todos sink：runTodos 通知 {runId, convId, todos} 且抛错被吞；hydrateRunTodos 不覆盖已有、不通知', () => {
  const calls = [];
  registerRunTodosSink((p) => calls.push(p));
  const run = createRun();
  run.convId = 'c_todos';
  runTodos(run, [{ content: '第一步' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { runId: run.id, convId: 'c_todos', todos: [{ content: '第一步' }] });

  // hydrate：起跑恢复；run 已有内容不覆盖；不回调 sink
  const run2 = createRun();
  run2.convId = 'c_todos';
  assert.equal(hydrateRunTodos(run2, [{ content: '旧计划' }]), true);
  assert.deepEqual(run2.todos.map((t) => t.content), ['旧计划']);
  assert.equal(calls.length, 1, 'hydrate 不通知 sink');
  assert.equal(hydrateRunTodos(run2, [{ content: '别的' }]), false);
  assert.deepEqual(run2.todos.map((t) => t.content), ['旧计划']);
  assert.equal(hydrateRunTodos(run2, []), false);
  assert.equal(hydrateRunTodos(null, [{ content: 'x' }]), false);

  // sink 抛错被吞：面板数据照常更新
  registerRunTodosSink(() => {
    throw new Error('boom');
  });
  assert.doesNotThrow(() => runTodos(run, [{ content: 'x' }]));
  assert.equal(run.todos[0].content, 'x');
  finishRun(run);
  finishRun(run2);
});
