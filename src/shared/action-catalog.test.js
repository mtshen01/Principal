import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAgentActions, renderActionCatalog } from './action-catalog.js';

const CONFIGS = [
  {
    id: 'ac_env',
    name: '清数据',
    description: '清掉指定环境的数据',
    botId: 'bot_1',
    enabled: true,
    permission: 'guest',
    variables: [
      { name: 'env', label: '环境', preset: 'env', required: true },
      { name: 'phone', label: '手机号', preset: 'phone', required: true, persistent: true },
      { name: 'note', label: '备注', required: false },
    ],
  },
  { id: 'ac_owner', name: '退款', botId: 'bot_1', enabled: true, permission: 'owner', variables: [] },
  { id: 'ac_off', name: '关掉的', botId: 'bot_1', enabled: false, permission: 'guest', variables: [] },
  { id: 'ac_hidden', name: '隐藏的', botId: 'bot_1', enabled: true, agentExposed: false, permission: 'guest', variables: [] },
  { id: 'ac_other', name: '别的 bot', botId: 'bot_2', enabled: true, permission: 'guest', variables: [] },
  { id: 'ac_noperm', name: '没写权限', botId: 'bot_1', enabled: true, variables: [] },
];

/** 灌入配置与存量变量（getVar 只认识 phone） */
function list(extra = {}, depsExtra = {}) {
  return listAgentActions(
    { botId: 'bot_1', userId: 'ou_x', ...extra },
    {
      getConfigs: () => CONFIGS,
      getVar: (_uid, name) => (name === 'phone' ? '13800138000' : null),
      ...depsExtra,
    },
  );
}

test('listAgentActions：四种过滤必须同时成立（enabled / botId / agentExposed / 权限）', () => {
  const actions = list();
  assert.deepEqual(actions.map((a) => a.id), ['ac_env']);
});

test('listAgentActions：permission 缺失 fail-closed（guest 看不到 owner 档与无权限动作）', () => {
  // ac_owner / ac_noperm 都被 canRunAction 拒 —— 与 run_action handler 同一判据
  assert.ok(!list().some((a) => a.id === 'ac_owner'));
  assert.ok(!list().some((a) => a.id === 'ac_noperm'));
});

test('listAgentActions：变量经 preset 展开（enum/example）且 required 保留', () => {
  const [env, phone, note] = list()[0].variables;
  assert.equal(env.name, 'env');
  assert.deepEqual(env.enum, ['dev', 'test', 'prod'], 'preset 的闭集必须展开给模型');
  assert.equal(env.required, true);
  assert.equal(phone.example, '13800138000');
  assert.equal(note.required, false);
});

test('listAgentActions：persistent 存量值脱敏后进清单（完整号码不进模型上下文）', () => {
  const phone = list()[0].variables.find((v) => v.name === 'phone');
  assert.equal(phone.last, '138****8000');
});

test('listAgentActions：无 userId 时不读存量值（last 恒 null）', () => {
  const actions = list({ userId: '' });
  for (const v of actions[0].variables) assert.equal(v.last, null);
});

test('renderActionCatalog：包含 id / 名称 / 变量说明，空清单返回空串', () => {
  const text = renderActionCatalog(list());
  assert.match(text, /- ac_env　清数据：清掉指定环境的数据/);
  assert.match(text, /环境（env，必填，可选值：dev\/test\/prod，示例：体验版）/);
  assert.match(text, /手机号（phone，必填，示例：13800138000，上次使用：138\*\*\*\*8000）/);
  assert.equal(renderActionCatalog([]), '');
});

test('renderActionCatalog：超长截断必须说出来（不能静默隐藏动作）', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `ac_${i}`,
    name: `动作${i}`,
    description: 'x'.repeat(60),
    variables: [],
  }));
  const text = renderActionCatalog(many, { maxChars: 200 });
  assert.match(text, /另有 \d+ 项动作未列出/);
});
