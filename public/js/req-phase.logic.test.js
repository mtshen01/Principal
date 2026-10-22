/**
 * 需求阶段判定 + 同事归属候选挑选的纯逻辑单测。
 *
 * 这里钉的是「哪些需求能被选、选完变成哪条」——两处 UI（侧栏需求列表分组、同事面板归属下拉）
 * 共用这套口径，判错的方向都很疼：把归档的放进来 → 用户给死需求发消息；把进行中的挡掉 →
 * 用户以为同事没被指派。UI（DOM）只按这里的结果画。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_PHASES, isActivePhase, splitAssignedReqs, resolveSelectedReqId } from './req-phase.logic.js';

test('ACTIVE_PHASES：进行中 = 评审/开发/测试/归档中；不含已归档与已废弃', () => {
  assert.deepEqual(ACTIVE_PHASES, ['review', 'dev', 'test', 'archiving']);
  assert.equal(ACTIVE_PHASES.includes('archived'), false);
  assert.equal(ACTIVE_PHASES.includes('discarded'), false);
});

test('isActivePhase：四个进行中阶段为真，归档/废弃为假', () => {
  for (const p of ['review', 'dev', 'test', 'archiving']) assert.equal(isActivePhase(p), true, p);
  assert.equal(isActivePhase('archived'), false);
  assert.equal(isActivePhase('discarded'), false);
});

test('isActivePhase：阶段缺失按进行中（数据缺口不藏需求）；不抛', () => {
  assert.equal(isActivePhase(undefined), true);
  assert.equal(isActivePhase(null), true);
  assert.equal(isActivePhase(''), true);
});

test('splitAssignedReqs：按阶段分两堆，保序；脏项跳过', () => {
  const reqs = [
    { id: 'r1', title: '开发中', phase: 'dev' },
    { id: 'r2', title: '已归档', phase: 'archived' },
    { id: 'r3', title: '已废弃', phase: 'discarded' },
    { id: 'r4', title: '评审中', phase: 'review' },
  ];
  const { active, archived } = splitAssignedReqs(reqs);
  assert.deepEqual(active.map((r) => r.id), ['r1', 'r4'], '只有进行中的进候选，且保持原序');
  assert.deepEqual(archived.map((r) => r.id), ['r2', 'r3'], '归档/废弃单独一堆，供提示文案用');

  const dirty = splitAssignedReqs([null, { title: '没 id' }, { id: 'ok' }, 'x']);
  assert.deepEqual(dirty.active.map((r) => r.id), ['ok'], '缺 id 的项丢掉，不当候选');
  assert.deepEqual(splitAssignedReqs(null), { active: [], archived: [] }, '入参不是数组时给空结果，不抛');
});

test('resolveSelectedReqId：只有一个候选 → 默认选中它（无需用户动手）', () => {
  assert.equal(resolveSelectedReqId([{ id: 'only' }], ''), 'only');
});

test('resolveSelectedReqId：用户已选的那条还合法 → 保留（轮询重刷不得重置选择）', () => {
  const active = [{ id: 'a' }, { id: 'b' }];
  assert.equal(resolveSelectedReqId(active, 'b'), 'b');
});

test('resolveSelectedReqId：已选的那条被归档筛掉 → 回落到第一条；空候选 → 空串', () => {
  const active = [{ id: 'a' }, { id: 'b' }];
  assert.equal(resolveSelectedReqId(active, 'gone'), 'a');
  assert.equal(resolveSelectedReqId([], 'a'), '');
  assert.equal(resolveSelectedReqId(null, 'a'), '', '入参不是数组时不抛');
});
