import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoAgentAction, revertReqChange, removeSupplement, discardTask, removeFigma } from './undo-agent-action.js';

const MERGED = { id: 'aa_1', undone: false, reqId: 'r_a1',
  undo: { kind: 'revert-merge', repo: 'D:/fe', branch: 'req/r_a1/agent-m1', baseBranch: 'feat/order', mergeSha: 'sha1' } };
const PENDING = { ...MERGED, id: 'aa_2', undo: { ...MERGED.undo, mergeSha: null } };
const APIDOC = { id: 'aa_3', undone: false, reqId: 'r_a1', undo: { kind: 'delete-apidoc', reqId: 'r_a1', name: 'order.md' } };

function deps(extra = {}) {
  return {
    getAction: (id) => ({ aa_1: MERGED, aa_2: PENDING, aa_3: APIDOC })[id] || null,
    markUndone: () => true,
    revertMergeCommit: async () => ({ ok: true }),
    deleteBranch: async () => ({ ok: true }),
    deleteApiDoc: () => ({ ok: true }),
    ...extra,
  };
}

test('撤销不存在的记录 → 明确错误', async () => {
  const r = await undoAgentAction('aa_nope', deps());
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

// —— 幂等：主机双击撤销按钮不能撤两次。两次 revert 会产生两个反向提交。
test('已撤销过的不重复撤', async () => {
  let called = false;
  const d = deps({
    getAction: () => ({ ...MERGED, undone: true }),
    revertMergeCommit: async () => { called = true; return { ok: true }; },
  });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.equal(called, false, '撤过的绝不能再撤一次');
});

// —— external 档（退款脚本这类）已发生、撤不回。必须明说，不能假装成功。
test('undo=null → 明确说撤不回，不假装成功', async () => {
  const d = deps({ getAction: () => ({ id: 'aa_x', undone: false, undo: null }) });
  const r = await undoAgentAction('aa_x', d);
  assert.equal(r.ok, false);
  assert.match(r.error, /撤不回|不可撤销|无法撤销/);
});

test('revert-merge 且已合并 → 走 revertMergeCommit，参数正确', async () => {
  let seen = null;
  const d = deps({ revertMergeCommit: async (repo, opts) => { seen = { repo, opts }; return { ok: true }; } });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, true);
  assert.equal(seen.repo, 'D:/fe');
  assert.equal(seen.opts.mergeCommit, 'sha1');
  assert.equal(seen.opts.task.branch, 'req/r_a1/agent-m1');
  assert.equal(seen.opts.task.baseBranch, 'feat/order');
});

// —— 还没合并（待合并态）时没有 merge commit 可 revert，改动只在分支上，删掉即撤销。
//    对一个不存在的 mergeCommit 做 revert 会直接失败。
test('revert-merge 但 mergeSha 为 null → 走删分支而非 revert', async () => {
  let deleted = null;
  let reverted = false;
  const d = deps({
    deleteBranch: async (repo, br) => { deleted = { repo, br }; return { ok: true }; },
    revertMergeCommit: async () => { reverted = true; return { ok: true }; },
  });
  const r = await undoAgentAction('aa_2', d);
  assert.equal(r.ok, true);
  assert.equal(reverted, false, '没合并过就不该 revert');
  assert.deepEqual(deleted, { repo: 'D:/fe', br: 'req/r_a1/agent-m1' });
});

test('delete-apidoc → 调 deleteApiDoc，参数正确', async () => {
  let seen = null;
  const d = deps({ deleteApiDoc: (reqId, name) => { seen = { reqId, name }; return { ok: true }; } });
  const r = await undoAgentAction('aa_3', d);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, { reqId: 'r_a1', name: 'order.md' });
});

// —— 这条是最重要的：撤销失败绝不能标记为已撤销。
//    标了之后主机再也点不了那个按钮，而改动其实还在分支上 —— 等于把问题永久藏起来。
test('撤销失败 → 不标记 undone', async () => {
  let marked = false;
  const d = deps({
    revertMergeCommit: async () => ({ ok: false, error: '冲突' }),
    markUndone: () => { marked = true; return true; },
  });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.match(r.error, /冲突/);
  assert.equal(marked, false, '撤销没成功就标已撤销，等于永久藏起这个问题');
});

test('撤销执行抛错 → 按失败处理，不标记 undone，不冒泡', async () => {
  let marked = false;
  const d = deps({
    revertMergeCommit: async () => { throw new Error('git 炸了'); },
    markUndone: () => { marked = true; return true; },
  });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.equal(marked, false);
});

test('撤销成功 → 标记 undone', async () => {
  let marked = false;
  const d = deps({ markUndone: () => { marked = true; return true; } });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, true);
  assert.equal(marked, true);
});

// —— P4：四种新 kind 的分派契约（执行逻辑在各 helper；这里钉「分派到位 + 成功才 mark」）

test('revert-req-change：参数透传 (reqId, changeId)，成功透传 note', async () => {
  let seen = null;
  const d = deps({
    getAction: () => ({ id: 'aa_c', undone: false, undo: { kind: 'revert-req-change', reqId: 'r_a1', changeId: 'c_1' } }),
    revertReqChange: async (...a) => ((seen = a), { ok: true, note: '已连同排队中的地图更新一起撤销' }),
  });
  const r = await undoAgentAction('aa_c', d);
  assert.deepEqual(seen, ['r_a1', 'c_1']);
  assert.equal(r.ok, true);
  assert.equal(r.note, '已连同排队中的地图更新一起撤销');
});

test('remove-supplement：参数透传 (reqId, supplementId)', async () => {
  let seen = null;
  const d = deps({
    getAction: () => ({ id: 'aa_s', undone: false, undo: { kind: 'remove-supplement', reqId: 'r_a1', supplementId: 's_1' } }),
    removeSupplement: async (...a) => ((seen = a), { ok: true }),
  });
  assert.equal((await undoAgentAction('aa_s', d)).ok, true);
  assert.deepEqual(seen, ['r_a1', 's_1']);
});

test('discard-task：参数透传 (taskId)，成功透传 note', async () => {
  let seen = null;
  const d = deps({
    getAction: () => ({ id: 'aa_t', undone: false, undo: { kind: 'discard-task', taskId: 't_1' } }),
    discardTask: async (...a) => ((seen = a), { ok: true, note: '任务已取消（还没开始开发）' }),
  });
  const r = await undoAgentAction('aa_t', d);
  assert.deepEqual(seen, ['t_1']);
  assert.equal(r.note, '任务已取消（还没开始开发）');
});

test('remove-figma：参数透传 (reqId, pageId, figmaId)', async () => {
  let seen = null;
  const d = deps({
    getAction: () => ({ id: 'aa_f', undone: false, undo: { kind: 'remove-figma', reqId: 'r_a1', pageId: 'p1', figmaId: 'fg-1' } }),
    removeFigma: async (...a) => ((seen = a), { ok: true }),
  });
  assert.equal((await undoAgentAction('aa_f', d)).ok, true);
  assert.deepEqual(seen, ['r_a1', 'p1', 'fg-1']);
});

test('新 kind 执行失败 → 不 markUndone（铁律对六种 kind 一致）', async () => {
  let marked = false;
  const d = deps({
    getAction: () => ({ id: 'aa_t', undone: false, undo: { kind: 'discard-task', taskId: 't_1' } }),
    discardTask: async () => ({ ok: false, error: '任务正在开发中，等它跑完再放弃' }),
    markUndone: () => ((marked = true), true),
  });
  const r = await undoAgentAction('aa_t', d);
  assert.equal(r.ok, false);
  assert.match(r.error, /开发中/);
  assert.equal(marked, false);
});

test('未知 kind → 拒绝，不静默成功', async () => {
  const d = deps({ getAction: () => ({ id: 'aa_x', undone: false, undo: { kind: '未来的某种撤销' } }) });
  const r = await undoAgentAction('aa_x', d);
  assert.equal(r.ok, false);
});

// ── P4：四个执行 helper 的真实逻辑（全部可注入，不碰真实盘）

test('revertReqChange：摘记录 + 撤下排队中同 changeId 的地图更新，note 说明', () => {
  const req = { id: 'r1', changes: [{ id: 'c1', text: '改按钮' }, { id: 'c2', text: '别的' }] };
  const saved = [];
  let matched = null;
  const r = revertReqChange('r1', 'c1', {
    getReq: () => req,
    updateReq: (id, patch, event) => saved.push({ id, patch, event }),
    cancelQueued: (_reqId, kind, match) => {
      matched = { kind, hit: match({ changeId: 'c1' }), miss: match({ changeId: 'c9' }) };
      return 1;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(saved[0].patch.changes.length, 1);
  assert.equal(saved[0].patch.changes[0].id, 'c2');
  assert.equal(matched.kind, 'mapchange');
  assert.equal(matched.hit, true);
  assert.equal(matched.miss, false);
  assert.match(r.note, /一起撤销/);
});

test('revertReqChange：记录已不存在 → 拒绝（上层据此不 markUndone）', () => {
  const r = revertReqChange('r1', 'c_gone', { getReq: () => ({ id: 'r1', changes: [] }), updateReq: () => {}, cancelQueued: () => 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /不在需求上/);
});

test('removeSupplement：排队中 → 撤下并说明；文档已消费 → 如实说明不自动回退', () => {
  const base = { id: 'r1', supplements: [{ id: 's1', at: '2026-10-01T00:00:00Z' }] };
  const saved = [];

  // 场景 A：排队中、未被消费
  let r = removeSupplement('r1', 's1', {
    getReq: () => ({ ...base, devDoc: { versions: [] } }),
    updateReq: (id, patch, event) => saved.push({ id, patch, event }),
    removeQueued: () => 1,
  });
  assert.equal(r.ok, true);
  assert.equal(saved[0].patch.supplements.length, 0);
  assert.match(r.note, /排队中的文档修订/);

  // 场景 B：文档已按它出过新版（at 晚于补充的 at）
  r = removeSupplement('r1', 's1', {
    getReq: () => ({ ...base, devDoc: { versions: [{ v: 2, at: '2026-10-02T00:00:00Z' }] } }),
    updateReq: () => {},
    removeQueued: () => 0,
  });
  assert.equal(r.ok, true);
  assert.match(r.note, /另发一条修正/);
});

test('discardTask：开发中拒绝 / 未开始取消 / 已完成走落盘侧放弃', async () => {
  // developing → 拒绝
  let r = await discardTask('t1', { getTaskFn: () => ({ id: 't1', status: 'developing' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /开发中/);

  // queued（未开始）→ 置 rejected
  const patches = [];
  r = await discardTask('t1', {
    getTaskFn: () => ({ id: 't1', status: 'queued' }),
    updateTaskFn: (id, patch, event) => patches.push({ id, patch, event }) && { id, ...patch },
  });
  assert.equal(r.ok, true);
  assert.equal(patches[0].patch.status, 'rejected');
  assert.equal(patches[0].patch.discarded, true);

  // done → 落盘侧放弃
  const calls = [];
  r = await discardTask('t1', {
    getTaskFn: () => ({ id: 't1', status: 'done' }),
    discardById: async (id) => (calls.push(id), { ok: true, task: { merged: false } }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['t1']);
  assert.match(r.note, /任务分支/);
});

test('removeFigma：过滤该条后写回版本；figma 不在 → 拒绝', () => {
  const map = { pages: [{ id: 'p1', name: '首页', figmas: [{ id: 'fg-1', url: 'u1' }, { id: 'fg-2', url: 'u2' }] }] };
  let written = null;
  const notes = [];
  const r = removeFigma('r1', 'p1', 'fg-1', {
    getReq: () => ({ id: 'r1' }),
    readMap: () => map,
    writeMap: (_req, m) => (written = m),
    updateReq: (_id, _patch, event) => notes.push(event),
    merge: (prev, incoming) => incoming,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(written.pages[0].figmas.map((f) => f.id), ['fg-2']);
  assert.match(notes[0], /撤销设计稿引用/);

  const miss = removeFigma('r1', 'p1', 'fg_x', { getReq: () => ({}), readMap: () => map, writeMap: () => {}, updateReq: () => {}, merge: (p, i) => i });
  assert.equal(miss.ok, false);
});
