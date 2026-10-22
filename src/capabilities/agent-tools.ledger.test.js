/**
 * 撤销台账（P4 通用写入器）的专项测试 —— 「乐观执行 + 可撤销」的生产者。
 *
 * 与 agent-tools.test.js 分开：那份测注册表契约与 MCP 装配，这份只钉台账写入的
 * 「什么时候写 / undo 怎么来 / 写入失败怎么办」。判据逐条见 agent-tools.js#recordLedger。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerAgentTool, clearAgentTools, buildAgentMcpServer } from './agent-tools.js';

beforeEach(clearAgentTools);

/** 造一个合法定义，各用例只改自己关心的字段 */
function def(patch = {}) {
  return {
    name: 'get_thing',
    description: '取一个东西',
    danger: 'safe',
    roles: ['*'],
    schema: { id: z.string() },
    handler: async () => ({ ok: true }),
    ...patch,
  };
}

/** 装配助手：注入台账替身，返回 { built, entries } */
function buildWithLedger(role = 'backend', ctx = { colleagueId: 'cl_1', role: 'backend', msgId: 'm_1' }) {
  const entries = [];
  const built = buildAgentMcpServer(role, { ctx, deps: { appendAction: (e) => entries.push(e) } });
  return { built, entries };
}

test('台账：reversible 成功 → 写完整条目（undo / 脱敏 input / resultBrief / reqId）', async () => {
  registerAgentTool(def({
    name: 'writer',
    danger: 'reversible',
    schema: { reqId: z.string(), phone: z.string() },
    handler: async () => ({ ok: true, reply: '已登记接口文档' }),
    buildUndo: (input) => ({ kind: 'delete-apidoc', reqId: input.reqId, name: 'order.md' }),
  }));
  const { built, entries } = buildWithLedger();
  const out = await built.defs[0].handler({ reqId: 'r_1', phone: '13800138000' }, {});

  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.tool, 'writer');
  assert.equal(e.colleagueId, 'cl_1');
  assert.equal(e.role, 'backend');
  assert.equal(e.msgId, 'm_1');
  assert.equal(e.reqId, 'r_1', 'reqId 优先取入参');
  assert.deepEqual(e.undo, { kind: 'delete-apidoc', reqId: 'r_1', name: 'order.md' });
  assert.equal(e.input.phone, '138****8000', '隐私字段落盘前脱敏');
  assert.match(e.resultBrief, /已登记/);
  // 返回值不受台账影响
  assert.equal(JSON.parse(out.content[0].text).reply, '已登记接口文档');
});

test('台账：reqId 入参缺失时回落 ctx.reqId', async () => {
  registerAgentTool(def({ name: 'w2', danger: 'reversible', handler: async () => ({ ok: 1 }), buildUndo: () => ({ kind: 'delete-apidoc' }) }));
  const entries = [];
  const built = buildAgentMcpServer('backend', { ctx: { reqId: 'r_ctx' }, deps: { appendAction: (e) => entries.push(e) } });
  await built.defs[0].handler({ id: 'x' }, {});
  assert.equal(entries[0].reqId, 'r_ctx');
});

test('台账：external 成功 → undo 必须为 null（已发生、撤不回，仍留审计）', async () => {
  registerAgentTool(def({ name: 'runner', danger: 'external', exposedFlag: 'agentExposed', handler: async () => ({ ok: true, output: '已退款' }) }));
  const { built, entries } = buildWithLedger();
  await built.defs[0].handler({ id: 'x' }, {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0].undo, null);
});

test('台账：safe / notify 不写', async () => {
  registerAgentTool(def({ name: 'reader', danger: 'safe' }));
  registerAgentTool(def({ name: 'notifier', danger: 'notify' }));
  const { built, entries } = buildWithLedger();
  for (const t of built.defs) await t.handler({ id: 'x' }, {});
  assert.equal(entries.length, 0);
});

test('台账：业务失败（{error}）与抛错都不写 —— 没有发生的事没有可撤销性', async () => {
  registerAgentTool(def({ name: 'failing', danger: 'reversible', handler: async () => ({ error: '需求不在开发期' }), buildUndo: () => ({ kind: 'delete-apidoc' }) }));
  registerAgentTool(def({ name: 'throwing', danger: 'reversible', handler: async () => { throw new Error('炸'); }, buildUndo: () => ({ kind: 'delete-apidoc' }) }));
  const { built, entries } = buildWithLedger();
  for (const t of built.defs) await t.handler({ id: 'x' }, {});
  assert.equal(entries.length, 0);
});

test('台账：ok:false 同样不写（run_action 脚本失败的形态）', async () => {
  registerAgentTool(def({ name: 'notok', danger: 'external', exposedFlag: 'x', handler: async () => ({ ok: false, output: '脚本退出码 1' }) }));
  const { built, entries } = buildWithLedger();
  await built.defs[0].handler({ id: 'x' }, {});
  assert.equal(entries.length, 0);
});

test('台账：reversible 的 buildUndo 给不出锚点 → 写 undo:null（降级为撤不回），不抛不吞', async () => {
  registerAgentTool(def({ name: 'anchorless', danger: 'reversible', handler: async () => ({ ok: 1 }), buildUndo: () => null }));
  const { built, entries } = buildWithLedger();
  const out = await built.defs[0].handler({ id: 'x' }, {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0].undo, null);
  assert.equal(JSON.parse(out.content[0].text).ok, 1);
});

test('台账：buildUndo 抛错同上，且工具返回不受影响', async () => {
  registerAgentTool(def({ name: 'anchorthrow', danger: 'reversible', handler: async () => ({ ok: 1 }), buildUndo: () => { throw new Error('炸'); } }));
  const { built, entries } = buildWithLedger();
  const out = await built.defs[0].handler({ id: 'x' }, {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0].undo, null);
  assert.equal(JSON.parse(out.content[0].text).ok, 1);
});

test('台账：selfLedger 的工具不即时写（锚点在收尾由执行端写，防留下撤不出的假记录）', async () => {
  registerAgentTool(def({ name: 'deferred', danger: 'reversible', selfLedger: true, handler: async () => ({ ok: 1 }), buildUndo: () => ({ kind: 'revert-merge' }) }));
  const { built, entries } = buildWithLedger();
  await built.defs[0].handler({ id: 'x' }, {});
  assert.equal(entries.length, 0);
});

test('台账：appendAction 抛错 → fail-open，工具结果照常返回', async () => {
  registerAgentTool(def({ name: 'w3', danger: 'reversible', handler: async () => ({ ok: 7 }), buildUndo: () => ({ kind: 'delete-apidoc' }) }));
  const built = buildAgentMcpServer('backend', { deps: { appendAction: () => { throw new Error('盘坏了'); } } });
  const out = await built.defs[0].handler({ id: 'x' }, {});
  assert.equal(JSON.parse(out.content[0].text).ok, 7);
});

test('台账：脱敏返回新对象，不污染业务入参（handler 与后续流程继续用原值）', async () => {
  const captured = {};
  registerAgentTool(def({
    name: 'w4',
    danger: 'reversible',
    handler: async (input) => { captured.phone = input.phone; return { ok: 1 }; },
    buildUndo: () => ({ kind: 'delete-apidoc' }),
  }));
  const { built, entries } = buildWithLedger();
  await built.defs[0].handler({ id: 'x', phone: '13800138000' }, {});
  assert.equal(captured.phone, '13800138000', 'handler 收到原值');
  assert.equal(entries[0].input.phone, '138****8000', '台账收到脱敏值');
});

// —— __private 约定：handler 当场生成的撤销锚点（taskId/supplementId/figmaId）
// 只有本层知道，buildUndo 要读、模型不该看（同「路径不经模型之手」的纪律）。
test('__private：模型看不到，buildUndo 读得到', async () => {
  let seenByUndo = null;
  registerAgentTool(def({
    name: 'priv',
    danger: 'reversible',
    handler: async () => ({ ok: true, reply: '已办', __private: { taskId: 't_9' } }),
    buildUndo: (_i, result) => {
      seenByUndo = result?.__private?.taskId;
      return { kind: 'discard-task', taskId: result?.__private?.taskId };
    },
  }));
  const { built, entries } = buildWithLedger();
  const out = await built.defs[0].handler({ id: 'x' }, {});

  assert.equal(seenByUndo, 't_9', 'buildUndo 必须拿到原始 result');
  assert.deepEqual(entries[0].undo, { kind: 'discard-task', taskId: 't_9' });
  assert.doesNotMatch(out.content[0].text, /t_9/, '模型上下文不得出现内部 id');
  assert.deepEqual(JSON.parse(out.content[0].text), { ok: true, reply: '已办' });
});

test('__private：resultBrief 用它的时候也要先剥掉（主机的摘要不背内部 id）', async () => {
  registerAgentTool(def({
    name: 'priv2',
    danger: 'reversible',
    handler: async () => ({ ok: true, __private: { taskId: 't_x' } }),
    buildUndo: () => ({ kind: 'discard-task' }),
  }));
  const { built, entries } = buildWithLedger();
  await built.defs[0].handler({ id: 'x' }, {});
  assert.doesNotMatch(entries[0].resultBrief, /t_x/);
});
