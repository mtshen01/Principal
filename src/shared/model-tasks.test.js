/**
 * 功能模型解析层测试（设置 → 模型 → 功能模型）。
 *
 * 覆盖四件事：
 *   1. 存储形状归一（normalizeTaskTarget）——非法形状一律 null，防脏配置进解析；
 *   2. 默认回落——无用户覆盖时与改造前的现状默认逐字一致（分类类 Haiku / 对话类 null）；
 *   3. 覆盖优先与清除回落——setModelTask 写、resolveTaskTarget/resolveTaskModel 读；
 *   4. 视图构建——数量/形状齐全，value 反映当前覆盖、fallback 给出默认目标。
 *
 * 零网络、零模型调用：只碰临时 APP_DATA_DIR 下的 settings.json 与纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tasks-'));

const { MODEL_TASK_IDS, normalizeTaskTarget } = await import('./model-task-catalog.js');
const { resolveTaskTarget, resolveTaskModel, buildModelTaskView, isKnownTaskId } = await import(
  './model-tasks.js'
);
const { setModelTask, getModelTasks } = await import('../store/settings.js');

test('normalizeTaskTarget：合法形状通过（trim/多余字段剥除），非法形状一律 null', () => {
  assert.deepEqual(normalizeTaskTarget({ provider: 'claude-agent', model: 'claude-haiku-4-5' }), {
    provider: 'claude-agent',
    model: 'claude-haiku-4-5',
  });
  assert.deepEqual(
    normalizeTaskTarget({ provider: 'openai-compat', credId: 'tk_1', model: 'deepseek-chat', junk: 1 }),
    { provider: 'openai-compat', credId: 'tk_1', model: 'deepseek-chat' },
  );
  assert.deepEqual(normalizeTaskTarget({ provider: 'claude-agent', model: ' claude-opus-5 ' }), {
    provider: 'claude-agent',
    model: 'claude-opus-5',
  });

  assert.equal(normalizeTaskTarget({ provider: 'claude-agent', model: '  ' }), null, '空模型非法');
  assert.equal(normalizeTaskTarget({ provider: 'claude-agent' }), null, '缺模型非法');
  assert.equal(normalizeTaskTarget({ provider: 'openai-compat', model: 'x' }), null, 'openai 目标缺 credId 非法');
  assert.equal(normalizeTaskTarget({ provider: 'nope', model: 'x' }), null, '未知 provider 非法');
  assert.equal(normalizeTaskTarget(null), null);
  assert.equal(normalizeTaskTarget([]), null, '数组非法');
  assert.equal(normalizeTaskTarget('x'), null, '字符串非法');
});

test('resolveTaskTarget：无覆盖 → 回落现状默认（分类类非空 Haiku / 对话类 null）', () => {
  for (const id of MODEL_TASK_IDS) setModelTask(id, null); // 清干净（可能带上一用例残留）
  const intent = resolveTaskTarget('intent');
  assert.equal(intent.provider, 'claude-agent');
  assert.ok(intent.model, 'intent 默认应为分类轻模型（config.intent.classifyModel）');
  const exec = resolveTaskTarget('feishuExec');
  assert.equal(exec.provider, 'claude-agent');
  assert.equal(exec.model, null, '对话类默认跟随 Claude Code（null）');
  // 未知 id 也走 fallback（返回默认目标），不抛错
  assert.equal(resolveTaskTarget('nope').provider, 'claude-agent');
});

test('setModelTask / resolveTaskTarget：覆盖优先；null 清除回落', () => {
  setModelTask('feishuExec', { provider: 'claude-agent', model: 'claude-opus-5' });
  assert.deepEqual(resolveTaskTarget('feishuExec'), { provider: 'claude-agent', model: 'claude-opus-5' });
  assert.equal(getModelTasks().feishuExec.model, 'claude-opus-5');

  setModelTask('feishuExec', { provider: 'openai-compat', credId: 'tk_demo', model: 'deepseek-reasoner' });
  assert.deepEqual(resolveTaskTarget('feishuExec'), {
    provider: 'openai-compat',
    credId: 'tk_demo',
    model: 'deepseek-reasoner',
  });

  setModelTask('feishuExec', null);
  assert.equal('feishuExec' in getModelTasks(), false, '清除后不留键');
  assert.equal(resolveTaskTarget('feishuExec').provider, 'claude-agent');
});

test('setModelTask：未知任务 id / 非法形状抛错（路由据此回 400）', () => {
  assert.throws(() => setModelTask('nope', { provider: 'claude-agent', model: 'x' }), /未知/);
  assert.throws(() => setModelTask('intent', { provider: 'claude-agent', model: '' }), /非法/);
  assert.throws(() => setModelTask('intent', { provider: 'openai-compat', credId: '', model: 'x' }), /非法/);
});

test('resolveTaskModel：显式覆盖 > 调用点入参 > 任务默认；openai 覆盖对 Claude 调用点返回 null', () => {
  setModelTask('memoryBank', null);
  // 无覆盖：调用点入参优先于任务默认
  assert.equal(resolveTaskModel('memoryBank', 'claude-sonnet-4-6'), 'claude-sonnet-4-6');
  // 无覆盖、无入参：回落任务默认（memoryBank → 分类轻模型，测试环境必非空）
  assert.equal(typeof resolveTaskModel('memoryBank'), 'string');
  // 用户覆盖压过调用点入参
  setModelTask('memoryBank', { provider: 'claude-agent', model: 'claude-opus-5' });
  assert.equal(resolveTaskModel('memoryBank', 'claude-sonnet-4-6'), 'claude-opus-5');
  // openai 覆盖 → Claude 通道取不到模型（调用点必须先 resolveTaskTarget 分派双通道）
  setModelTask('memoryBank', { provider: 'openai-compat', credId: 'tk_1', model: 'qwen-max' });
  assert.equal(resolveTaskModel('memoryBank'), null);
  setModelTask('memoryBank', null);
});

test('buildModelTaskView：数量/形状齐全，value 反映当前覆盖、fallback 给默认目标', () => {
  for (const id of MODEL_TASK_IDS) setModelTask(id, null);
  const view = buildModelTaskView();
  assert.equal(view.length, MODEL_TASK_IDS.length);
  for (const v of view) {
    assert.equal(typeof v.label, 'string');
    assert.equal(typeof v.group, 'string');
    assert.ok(v.hint === undefined || typeof v.hint === 'string');
    assert.equal(v.value, null, '未覆盖时 value 为 null');
    assert.ok(v.fallback && v.fallback.provider, 'fallback 应给出默认目标');
  }

  setModelTask('autoTier', { provider: 'claude-agent', model: 'claude-opus-5' });
  const v2 = buildModelTaskView().find((v) => v.id === 'autoTier');
  assert.deepEqual(v2.value, { provider: 'claude-agent', model: 'claude-opus-5' });
  assert.deepEqual(v2.fallback, { provider: 'claude-agent', model: 'claude-haiku-4-5' }, '判档默认恒为 Haiku');
  setModelTask('autoTier', null);
});

test('isKnownTaskId：目录内 true、其余 false', () => {
  assert.equal(isKnownTaskId('intent'), true);
  assert.equal(isKnownTaskId(''), false);
  assert.equal(isKnownTaskId('nope'), false);
});
