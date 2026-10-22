/**
 * 工具清单分叉单测：两家工具集互不串台、id 唯一、openai 不得出现 Claude 专属工具。
 * 这里的错配是「UI 显示的工具根本不是那条路径跑的」——用户关了没反应、真工具关不掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_BUILTIN_TOOLS, OPENAI_BUILTIN_TOOLS, builtinToolsFor } from './tool-list.logic.js';

test('builtinToolsFor：openai-compat 走 openai 清单；其它（含未知/缺省）走 Claude 清单', () => {
  assert.equal(builtinToolsFor('openai-compat'), OPENAI_BUILTIN_TOOLS);
  assert.equal(builtinToolsFor('claude-agent'), CLAUDE_BUILTIN_TOOLS);
  assert.equal(builtinToolsFor(undefined), CLAUDE_BUILTIN_TOOLS);
  assert.equal(builtinToolsFor('weird'), CLAUDE_BUILTIN_TOOLS);
});

test('openai 清单 = 真实装配的工具集（含自研的 Workflow 编排 + P1-7 子代理控制面）', () => {
  const ids = OPENAI_BUILTIN_TOOLS.map((t) => t.id);
  for (const id of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'RepoMap', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Workflow', 'AskColleague', 'WaitColleagueReply', 'exec_command', 'send_message', 'wait_agent', 'interrupt_agent', 'list_agents']) {
    assert.ok(ids.includes(id), `openai 清单缺 ${id}`);
  }
  // 子代理控制面只有 openai 路径有（Claude 路径的 Task 是 SDK 原生，我们拿不到句柄）
  const claudeIds = CLAUDE_BUILTIN_TOOLS.map((t) => t.id);
  for (const id of ['send_message', 'wait_agent', 'interrupt_agent', 'list_agents']) {
    assert.equal(claudeIds.includes(id), false, `Claude 清单不应含 ${id}`);
  }
  // Workflow 两家都有，但实现不同：Claude 是 CLI 自带工具，openai 是本仓自研编排
  // （capabilities/workflow.logic.js，Ultracode 档授权才注入）——两边都得能关，用户才拦得住额度。
  assert.ok(ids.includes('Workflow'), 'openai 清单应含 Workflow（自研编排）');
});

test('Claude 清单：含 SDK 全套 + 进程内 MCP 的「问同事」两项，不含 openai 专属项', () => {
  const ids = CLAUDE_BUILTIN_TOOLS.map((t) => t.id);
  for (const id of ['Bash', 'Write', 'Edit', 'Read', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Workflow', 'TodoWrite', 'AskColleague', 'WaitColleagueReply']) {
    assert.ok(ids.includes(id), `Claude 清单缺 ${id}`);
  }
  // Claude 的 Glob/LS 已并入 Grep 行；RepoMap 只有 openai 路径有
  for (const id of ['Glob', 'RepoMap', 'exec_command']) {
    assert.equal(ids.includes(id), false, `Claude 清单不应含 ${id}`);
  }
});

test('两份清单：条目形状完整（id/label/desc）、id 各自唯一', () => {
  for (const list of [CLAUDE_BUILTIN_TOOLS, OPENAI_BUILTIN_TOOLS]) {
    const seen = new Set();
    for (const t of list) {
      assert.ok(t.id && typeof t.id === 'string');
      assert.ok(t.label && typeof t.label === 'string');
      assert.ok(t.desc && typeof t.desc === 'string');
      assert.equal(seen.has(t.id), false, `重复 id：${t.id}`);
      seen.add(t.id);
    }
  }
});
