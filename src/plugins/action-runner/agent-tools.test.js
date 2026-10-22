import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunActionTool, RUN_ACTION } from './agent-tools.js';

const ENV_ACTION = {
  id: 'ac_env',
  name: '清理账号数据',
  enabled: true,
  permission: 'guest',
  botId: 'bot_1',
  variables: [
    { name: 'env', label: '环境', preset: 'env', required: true },
    { name: 'phone', label: '手机号', preset: 'phone', required: true, persistent: true },
  ],
};

const OWNER_ACTION = { ...ENV_ACTION, id: 'ac_owner', name: '退款', permission: 'owner', variables: [] };

/** 注入替身的工具实例 + 调用记录 */
function make(extra = {}) {
  const calls = { run: [], saved: [] };
  const tool = buildRunActionTool({
    getConfig: (id) => ({ ac_env: ENV_ACTION, ac_owner: OWNER_ACTION })[id] || null,
    getVar: () => null,
    setVar: (...a) => calls.saved.push(a),
    runAction: async (...a) => {
      calls.run.push(a);
      return { ok: true, output: '✅ 清理完成' };
    },
    describeTarget: () => '环境 dev ｜ 手机号 138****8000',
    ...extra,
  });
  return { tool, calls };
}

const CTX = { openId: 'ou_x', colleagueId: 'cl_1' };

test('run_action：定义形状（唯一 external + exposedFlag + 全员可见）', () => {
  const { tool } = make();
  assert.equal(tool.name, RUN_ACTION);
  assert.equal(tool.danger, 'external');
  assert.equal(tool.exposedFlag, 'agentExposed');
  assert.deepEqual(tool.roles, ['*']);
  assert.ok(tool.description.includes('确认'), '确认制必须写进 description（软约束的第一处）');
});

test('run_action：未知动作 id → error，不执行', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_nope' }, CTX);
  assert.match(out.error, /没有找到动作/);
  assert.equal(calls.run.length, 0);
});

test('run_action：agentExposed=false 的动作拒绝（硬开关与清单同判据）', async () => {
  const { tool, calls } = make({
    getConfig: () => ({ ...ENV_ACTION, agentExposed: false }),
  });
  const out = await tool.handler({ action: 'ac_env' }, CTX);
  assert.match(out.error, /没有开放/);
  assert.equal(calls.run.length, 0);
});

test('run_action：owner 档动作对同事一律拒绝（canRunAction 原闸）', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_owner' }, CTX);
  assert.match(out.error, /权限/);
  assert.equal(calls.run.length, 0);
});

test('run_action：缺必填 → error + missing（带可选值/示例），不执行（模型据此追问）', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'dev' } }, CTX);
  assert.ok(out.error);
  assert.deepEqual(out.missing, [{ name: 'phone', label: '手机号', enum: null, example: '13800138000' }]);
  assert.match(out.error, /示例：13800138000/, '追问文案带出示例，短回复才绑得回变量');
  assert.equal(calls.run.length, 0);
});

test('run_action：声明外的参数直接拒（防模型自创变量名）', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'dev', phone: '13800138000', extra: 'x' } }, CTX);
  assert.match(out.error, /不属于该动作/);
  assert.equal(calls.run.length, 0);
});

test('run_action：enum 收窄后，别名映射到被禁值仍拒绝（闭集是管理员用来禁 prod 的闸）', async () => {
  const narrowed = {
    ...ENV_ACTION,
    variables: [
      { name: 'env', label: '环境', preset: 'env', enum: ['dev', 'test'], required: true },
      { name: 'phone', label: '手机号', preset: 'phone', required: true, persistent: true },
    ],
  };
  const { tool, calls } = make({ getConfig: () => narrowed });
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'production', phone: '13800138000' } }, CTX);
  assert.match(out.error, /dev \/ test/);
  assert.equal(calls.run.length, 0);
});

test('run_action：enum 别名归一（「开发环境」→ dev，脚本拿到规范值）', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_env', vars: { env: '开发环境', phone: '13800138000' } }, CTX);
  assert.equal(out.ok, true);
  assert.deepEqual(calls.run[0][2], { env: 'dev', phone: '13800138000' });
});

test('run_action：weakAlias 也认（「开发」这种裸词，追问轮口径）', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_env', vars: { env: '开发', phone: '13800138000' } }, CTX);
  assert.equal(out.ok, true);
  assert.deepEqual(calls.run[0][2], { env: 'dev', phone: '13800138000' });
});

test('run_action：enum 别名带尾巴词（「dev 环境」→ dev）', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'dev 环境', phone: '13800138000' } }, CTX);
  assert.equal(out.ok, true);
  assert.deepEqual(calls.run[0][2], { env: 'dev', phone: '13800138000' });
});

test('run_action：pattern 违规不执行', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'dev', phone: '123' } }, CTX);
  assert.match(out.error, /格式/);
  assert.equal(calls.run.length, 0);
});

test('run_action：成功 → 执行并回执（output 截尾 + target），持久变量落盘', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'dev', phone: '13800138000' } }, CTX);

  assert.equal(out.ok, true);
  assert.match(out.output, /清理完成/);
  assert.match(out.target, /手机号/);
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0][0].id, 'ac_env');
  assert.equal(calls.run[0][1], 'ou_x', 'userId 用同事 openId（与老路径 user-vars 同键）');
  assert.deepEqual(calls.run[0][2], { env: 'dev', phone: '13800138000' });
  assert.deepEqual(calls.saved, [['ou_x', 'phone', '13800138000']], '只有 persistent 变量落盘');
});

test('run_action：persistent 存量值补缺（不报号也能复用上次），并支持数字值转字符串', async () => {
  const { tool, calls } = make({ getVar: (_u, name) => (name === 'phone' ? '13900139000' : null) });
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'dev' } }, CTX);
  assert.equal(out.ok, true);
  assert.deepEqual(calls.run[0][2], { env: 'dev', phone: '13900139000' });
});

test('run_action：脚本失败 → ok:false + 原始输出（模型如实转述）', async () => {
  const { tool } = make({
    runAction: async () => ({ ok: false, output: '❌ 账号不存在' }),
  });
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'dev', phone: '13800138000' } }, CTX);
  assert.equal(out.ok, false);
  assert.match(out.output, /账号不存在/);
});

test('run_action：缺 openId（ctx 不完整）时不碰 user-vars，但带齐参数可执行', async () => {
  const { tool, calls } = make({ getVar: () => { throw new Error('不该被调用'); } });
  const out = await tool.handler({ action: 'ac_env', vars: { env: 'test', phone: '13800138000' } }, {});
  assert.equal(out.ok, true);
  assert.equal(calls.saved.length, 0);
});
