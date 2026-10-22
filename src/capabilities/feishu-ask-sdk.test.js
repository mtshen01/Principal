/**
 * feishu-ask-sdk.js 测试：Claude Agent SDK 版 MCP server 的装配与免审批集合。
 * 只验证形状/常量（不真跑 MCP 协议）——避免把用例绑死在 SDK 内部结构上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeishuAskMcpServer,
  FEISHU_ASK_SDK_SERVER,
  FEISHU_ASK_SDK_READONLY,
  FEISHU_ASK_SDK_ALIASES,
} from './feishu-ask-sdk.js';
import { createFeishuAskTools, FEISHU_ASK_TOOL_NAMES } from './feishu-ask-tools.js';
import { createPolicyGate } from './tool-policy.js';

test('readOnly 用**全名**（策略门是 Set.has 精确匹配，写短名会静默变成每次都弹审批）', () => {
  assert.equal(FEISHU_ASK_SDK_SERVER, 'feishu-ask');
  assert.deepEqual([...FEISHU_ASK_SDK_READONLY], ['mcp__feishu-ask__WaitColleagueReply']);
});

test('别名表把 MCP 全名映回逻辑名（否则右下角工具开关管不到这两个工具）', () => {
  assert.deepEqual(FEISHU_ASK_SDK_ALIASES, {
    'mcp__feishu-ask__AskColleague': 'AskColleague',
    'mcp__feishu-ask__WaitColleagueReply': 'WaitColleagueReply',
  });
  // 与工具清单同源：每个工具名都有别名，新增工具不会漏配开关
  for (const n of FEISHU_ASK_TOOL_NAMES) {
    assert.equal(FEISHU_ASK_SDK_ALIASES[`mcp__${FEISHU_ASK_SDK_SERVER}__${n}`], n);
  }
});

test('接线：逻辑名禁用后 MCP 全名被拒；disabled 优先于免审批（关掉真的关得掉）', () => {
  const mkGate = (disabled) =>
    createPolicyGate({ alias: FEISHU_ASK_SDK_ALIASES, disabledTools: disabled, readOnlyExtra: FEISHU_ASK_SDK_READONLY, level: 'default' });
  const disabled = mkGate(new Set(['AskColleague', 'WaitColleagueReply']));
  assert.equal(disabled.decide('mcp__feishu-ask__AskColleague', {}).action, 'deny');
  // WaitColleagueReply 本在 readOnlyExtra 免审批，但 disabled 判在前 → 仍拒绝
  const waitDenied = disabled.decide('mcp__feishu-ask__WaitColleagueReply', {});
  assert.equal(waitDenied.action, 'deny');
  assert.equal(waitDenied.ruleId, 'disabled_tool');
  // 未禁用时：等待工具免审批放行、提问走审批（不为放宽既有语义）
  const enabled = mkGate(new Set());
  assert.equal(enabled.decide('mcp__feishu-ask__WaitColleagueReply', {}).action, 'allow');
  assert.equal(enabled.decide('mcp__feishu-ask__AskColleague', {}).action, 'ask');
});

test('buildFeishuAskMcpServer：取 zod raw shape 造出 server（能构造即证明 .shape 可用）', () => {
  const { server, readOnly } = buildFeishuAskMcpServer({ runId: 'run_1', convId: 'conv_1' });
  assert.ok(server, '应返回进程内 MCP server');
  assert.equal(readOnly, FEISHU_ASK_SDK_READONLY);
});

test('契约：AskColleague 的 zod raw shape 含 options（SDK tool() 依赖它）', () => {
  const { toolDefs } = createFeishuAskTools();
  assert.deepEqual(Object.keys(toolDefs.AskColleague.inputSchema.shape).sort(), [
    'context',
    'name',
    'options',
    'question',
    'role',
  ]);
});
