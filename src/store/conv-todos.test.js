/**
 * 任务清单（plan）落盘（P1-9）单测：归一 / 往返 / 空删键 / render 标记 / 上限淘汰 / 损坏即抛 / 清理。
 * 隔离：APP_DATA_DIR → 临时目录；动态 import（store 基座在模块求值时定死数据目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-todos-'));
process.env.APP_DATA_DIR = DATA;

const { sanitizeTodos, getConvTodos, setConvTodos, renderPlanSection, clearAllConvTodos, MAX_CONVS } = await import('./conv-todos.js');

const file = () => path.join(DATA, 'conv-todos.json');

test.beforeEach(() => clearAllConvTodos());

test('sanitizeTodos：trim / status 白名单 / activeForm 可选 / 空内容剔除 / 50 项截断 / 非对象容忍', () => {
  const out = sanitizeTodos([
    { content: '  写测试  ', status: 'in_progress', activeForm: ' 正在写测试 ' },
    { content: '坏状态', status: 'doing' },
    { content: '' },
    null,
    'x',
    { content: 'ok' },
    ...Array.from({ length: 60 }, (_, i) => ({ content: 'n' + i, status: 'pending' })),
  ]);
  assert.deepEqual(out[0], { content: '写测试', status: 'in_progress', activeForm: '正在写测试' });
  assert.deepEqual(out[1], { content: '坏状态', status: 'pending' });
  assert.equal(out.length, 50, '50 项硬上限（坏条目已剔除后仍截断）');
  assert.equal(out.some((t) => !t.content), false);
});

test('往返：set → get 原样（归一后）；空清单删键；runId/at 保留', () => {
  assert.equal(getConvTodos('c1'), null, '无记录 → null');
  setConvTodos('c1', [{ content: '修复登录', status: 'in_progress', activeForm: '正在修复登录' }, { content: '写测试' }], {
    runId: 'run_1',
    now: 1000,
  });
  const got = getConvTodos('c1');
  assert.deepEqual(got.todos, [
    { content: '修复登录', status: 'in_progress', activeForm: '正在修复登录' },
    { content: '写测试', status: 'pending' },
  ]);
  assert.equal(got.runId, 'run_1');
  assert.equal(got.at, 1000);

  setConvTodos('c1', [{ content: '只做一件', status: 'completed' }], { runId: 'run_2', now: 2000 });
  assert.deepEqual(getConvTodos('c1').todos.map((t) => t.content), ['只做一件'], '覆盖式');

  setConvTodos('c1', [], { now: 3000 });
  assert.equal(getConvTodos('c1'), null, '空清单 = 删键');
  assert.equal(setConvTodos('', [{ content: 'x' }]), false, '缺 convId 不受理');
});

test('上限：超过 MAX_CONVS 时按 at 淘汰最旧，当前 conv 必保留', () => {
  for (let i = 0; i <= MAX_CONVS; i++) {
    setConvTodos('c_' + i, [{ content: 't' + i }], { now: 1000 + i });
  }
  assert.equal(getConvTodos('c_0'), null, '最旧的被淘汰（插入 301 条只挤掉 1 条）');
  assert.ok(getConvTodos('c_1'), '次旧的保留');
  assert.ok(getConvTodos('c_' + MAX_CONVS), '刚写入的保留');
  // 总数上限：读文件直接数 conv 键
  const state = JSON.parse(fs.readFileSync(file(), 'utf8'));
  assert.equal(Object.keys(state.convs).length, MAX_CONVS);
});

test('renderPlanSection：空 → 空串；三种状态标记；进行中带 activeForm；只渲染清单', () => {
  assert.equal(renderPlanSection([]), '');
  assert.equal(renderPlanSection(null), '');
  const section = renderPlanSection([
    { content: '定位问题', status: 'completed' },
    { content: '修复登录', status: 'in_progress', activeForm: '正在修复登录' },
    { content: '写回归测试', status: 'pending' },
  ]);
  const lines = section.split('\n');
  assert.match(lines[0], /## 任务清单/);
  assert.equal(lines[1], '[x] 定位问题');
  assert.equal(lines[2], '[>] 修复登录（进行中：正在修复登录）');
  assert.equal(lines[3], '[ ] 写回归测试');
  assert.equal(section.includes('正在修复登录）。'), false, '不拼接多余标点');
});

test('损坏即抛；clearAllConvTodos 可重复', () => {
  fs.writeFileSync(file(), '{broken');
  assert.throws(() => getConvTodos('c1'), /已损坏|解析失败/);
  assert.throws(() => setConvTodos('c1', [{ content: 'x' }]), /已损坏|解析失败/);
  fs.writeFileSync(file(), JSON.stringify({ v: 1, convs: {} }));
  clearAllConvTodos();
  assert.equal(getConvTodos('c1'), null);
});
