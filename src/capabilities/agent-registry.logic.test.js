/**
 * 子代理注册表纯函数层单测：状态机（终态不可复活）、命名/寻址、journal 归约（与运行时同源）、
 * 文案、等待夹取、工具 schema。
 *
 * 钉这些的理由：状态机是「本轮到底发生过什么」的唯一规则；归约错了，回放看到的历史就是假的；
 * 命名/寻址错了，`send_message` 会打到别的子代理身上（比报错更糟）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MAX_BACKGROUND,
  AGENT_REGISTRY_TOOL_DEFS,
  AGENT_TOOL_NAMES,
  LIST_SUMMARY_CLIP,
  MAILBOX_MAX,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  WAIT_MIN_MS,
  applyAgentEvent,
  buildAgentName,
  canTransition,
  clampWaitMs,
  createAgentState,
  formatAgentLine,
  formatAtCapacity,
  formatInterruptAck,
  formatMailboxFull,
  formatSendAck,
  formatSpawnAck,
  formatUnknownAgent,
  formatWaitResult,
  formatWaitTimeout,
  isTerminal,
  nextAgentId,
  reduceAgentEvents,
  renderAgentList,
  selectAgent,
  slugifyAgentLabel,
  statusLabel,
} from './agent-registry.logic.js';

const ev = (data, at = 1000) => ({ type: 'agent_status', at, data });
const base = (extra = {}) => ({
  agentId: 'a1',
  name: '/root/探查-1',
  provider: 'openai-subagent',
  role: 'explorer',
  label: '子代理',
  status: 'running',
  turns: 1,
  ...extra,
});

test('状态机：合法迁移表 + 终态判定', () => {
  assert.deepEqual([isTerminal('pending'), isTerminal('running'), isTerminal('completed')], [false, false, true]);
  assert.equal(isTerminal('interrupted'), true);
  assert.equal(isTerminal('errored'), true);
  assert.equal(canTransition('pending', 'running'), true);
  assert.equal(canTransition('running', 'completed'), true);
  // 终态不可复活：起新一轮是**新的一轮**（终态 → running 是唯一允许的「回活」）
  assert.equal(canTransition('completed', 'running'), true);
  assert.equal(canTransition('completed', 'errored'), false);
  assert.equal(canTransition('pending', 'completed'), false);
  assert.equal(canTransition('running', 'pending'), false);
});

test('applyAgentEvent：首次落地建条目、身份字段不被后续事件覆盖', () => {
  const s = createAgentState();
  const first = { ...base({ status: 'pending', turns: 0 }), name: '/root/x-1' };
  applyAgentEvent(s, ev(first, 500));
  assert.equal(s.order.length, 1);
  assert.equal(s.agents.a1.status, 'pending');
  assert.equal(s.agents.a1.lastAt, 500);
  applyAgentEvent(s, ev(base(), 900));
  assert.equal(s.agents.a1.status, 'running');
  assert.equal(s.agents.a1.startedAt, 900);
  assert.equal(s.agents.a1.turns, 1);
  // 身份字段（名字）不随后续事件变
  applyAgentEvent(s, ev({ ...base(), name: '/root/改名-9' }, 950));
  assert.equal(s.agents.a1.name, '/root/x-1');
});

test('applyAgentEvent：非法迁移 / 未知状态 / 缺 agentId 一律显式抛错，不静默擦状态', () => {
  const s = createAgentState();
  applyAgentEvent(s, ev(base()));
  assert.throws(() => applyAgentEvent(s, ev(base({ status: 'pending' }))), /非法 agent 状态迁移/);
  assert.throws(() => applyAgentEvent(s, ev(base({ status: 'zombie' }))), /未知 agent 状态/);
  assert.throws(() => applyAgentEvent(s, ev({ status: 'running' })), /缺少 agentId/);
});

test('applyAgentEvent：第二轮（终态 → running）刷新本轮起点，usage 累计', () => {
  const s = reduceAgentEvents([
    ev(base(), 100),
    ev(base({ status: 'completed', turns: 1, ms: 800, inputTokens: 100, outputTokens: 20, summaryHead: '第一轮结论' }), 900),
  ]);
  assert.equal(s.agents.a1.status, 'completed');
  assert.equal(s.agents.a1.startedAt, 100);
  assert.equal(s.agents.a1.ms, 800);
  assert.deepEqual(s.agents.a1.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(s.agents.a1.summaryHead, '第一轮结论');
  // 第二轮
  applyAgentEvent(s, ev(base({ turns: 2 }), 1000));
  assert.equal(s.agents.a1.status, 'running');
  assert.equal(s.agents.a1.startedAt, 1000); // 「已跑多久」按当前这一轮算
  applyAgentEvent(s, ev(base({ status: 'interrupted', turns: 2, ms: 300, inputTokens: 180, outputTokens: 45 }), 1300));
  assert.equal(s.agents.a1.turns, 2);
  assert.deepEqual(s.agents.a1.usage, { inputTokens: 180, outputTokens: 45 });
});

test('reduceAgentEvents：只吃 agent_status；同源归约两次结果一致（回放可信）', () => {
  const events = [
    { type: 'submitted', at: 1, data: {} },
    ev(base({ status: 'pending', turns: 0 }), 10),
    ev(base({ turns: 1, inputTokens: 10 }), 20),
    ev(base({ status: 'completed', turns: 1, ms: 500, inputTokens: 10, outputTokens: 5, summaryHead: 'ok' }), 30),
    ev(base({ agentId: 'a2', name: '/root/二-2', status: 'errored' }), 40),
  ];
  const a = reduceAgentEvents(events);
  const b = reduceAgentEvents(events);
  assert.deepEqual(a, b);
  assert.deepEqual(a.order, ['a1', 'a2']);
  assert.equal(a.agents.a2.status, 'errored');
});

test('命名与寻址：id 递增、名字 slug 化且唯一、按 id 或名字都能找到', () => {
  const s = createAgentState();
  assert.equal(nextAgentId(s), 'a1');
  assert.equal(buildAgentName(s, '支付 模块/审查'), '/root/支付-模块-审查-1');
  applyAgentEvent(s, ev({ agentId: 'a1', name: buildAgentName(s, '支付 模块/审查'), status: 'running' }), 1);
  assert.equal(nextAgentId(s), 'a2');
  assert.equal(buildAgentName(s, '支付 模块/审查'), '/root/支付-模块-审查-2');
  assert.equal(slugifyAgentLabel('   '), 'agent');
  assert.equal(slugifyAgentLabel('x'.repeat(40)), 'x'.repeat(24) + '…'); // 头截断（中段截断会把换行插进名字里）
  assert.equal(slugifyAgentLabel('x'.repeat(40)).includes('\n'), false);
  assert.equal(selectAgent(s, 'a1').id, 'a1');
  assert.equal(selectAgent(s, '/root/支付-模块-审查-1').id, 'a1');
  assert.equal(selectAgent(s, '不存在'), null);
  assert.equal(selectAgent(s, ''), null);
});

test('文案：派发/发送/等待/中断/未知/容量各自可读且带 id', () => {
  const agent = { id: 'a2', name: '/root/x-2', label: '子代理', status: 'running', turns: 2, usage: {} };
  assert.match(formatSpawnAck(agent), /a2/);
  assert.match(formatSpawnAck(agent), /wait_agent/);
  assert.match(formatSendAck(agent, 'started'), /起第 2 轮/);
  assert.match(formatSendAck(agent, 'queued'), /自动接续/);
  assert.match(formatWaitTimeout(agent, 30_000), /仍在运行/);
  assert.match(formatWaitTimeout(agent, 30_000), /30\.0s/);
  assert.match(formatWaitResult({ ...agent, status: 'completed', summary: '结论正文' }), /结论正文/);
  assert.match(formatWaitResult({ ...agent, status: 'errored', error: 'boom' }), /boom/);
  assert.match(formatWaitResult({ ...agent, status: 'interrupted' }), /已被中断/);
  assert.match(formatWaitResult({ ...agent, status: 'interrupted', summary: '半截' }), /半截/);
  assert.match(formatInterruptAck(agent, true), /已中断子代理 a2/);
  assert.match(formatInterruptAck({ ...agent, status: 'completed' }, false), /没有在跑/);
  assert.match(formatUnknownAgent('a9'), /a9/);
  assert.match(formatMailboxFull(agent), new RegExp(String(MAILBOX_MAX)));
  assert.match(formatAtCapacity(), new RegExp(String(AGENT_MAX_BACKGROUND)));
  assert.equal(statusLabel('running'), '运行中');
  assert.equal(statusLabel('??'), '??');
});

test('renderAgentList / formatAgentLine：空表给指路，有表出 id/状态/耗时/token/摘要', () => {
  const s = createAgentState();
  assert.match(renderAgentList(s), /还没有派过子代理/);
  applyAgentEvent(s, ev(base({ status: 'completed', turns: 1, ms: 1234, inputTokens: 300, outputTokens: 100, summaryHead: '查到了三处' }), 100));
  const text = renderAgentList(s, { now: 2000 });
  assert.match(text, /本轮子代理（1 个）/);
  assert.match(text, /a1/);
  assert.match(text, /已完成/);
  assert.match(text, /1\.2s/);
  assert.match(text, /400 tokens/);
  assert.match(text, /查到了三处/);
  // 运行中的行报「已跑」，摘要用事件里的 summaryHead（有界），错误优先于摘要
  const running = formatAgentLine({ ...s.agents.a1, status: 'running', startedAt: 1500, ms: 0, summaryHead: '' }, { now: 2000 });
  assert.match(running, /已跑 500ms/);
  const failed = formatAgentLine({ ...s.agents.a1, status: 'errored', error: '超时' });
  assert.match(failed, /错误：超时/);
  // 摘要在纯状态里是有界的（journal 是事实骨架，不放结论全文）
  assert.ok(s.agents.a1.summaryHead.length <= LIST_SUMMARY_CLIP);
});

test('clampWaitMs：缺省 30s，1s–300s 夹取', () => {
  assert.equal(clampWaitMs(undefined), WAIT_DEFAULT_MS);
  assert.equal(clampWaitMs(0), WAIT_DEFAULT_MS);
  assert.equal(clampWaitMs('abc'), WAIT_DEFAULT_MS);
  assert.equal(clampWaitMs(1), WAIT_MIN_MS);
  assert.equal(clampWaitMs(5000), 5000);
  assert.equal(clampWaitMs(999999), WAIT_MAX_MS);
});

test('工具 schema：四件套齐全，agent_id 必填，timeout_ms 兼容字符串数字', () => {
  assert.deepEqual(Object.keys(AGENT_REGISTRY_TOOL_DEFS), [...AGENT_TOOL_NAMES]);
  const send = AGENT_REGISTRY_TOOL_DEFS.send_message.inputSchema;
  assert.equal(send.safeParse({ agent_id: 'a1', message: 'hi' }).success, true);
  assert.equal(send.safeParse({ message: 'hi' }).success, false);
  const wait = AGENT_REGISTRY_TOOL_DEFS.wait_agent.inputSchema;
  assert.equal(wait.safeParse({ agent_id: 'a1' }).success, true);
  const parsed = wait.parse({ agent_id: 'a1', timeout_ms: '5000' });
  assert.equal(parsed.timeout_ms, 5000);
  const interrupt = AGENT_REGISTRY_TOOL_DEFS.interrupt_agent.inputSchema;
  assert.equal(interrupt.safeParse({ agent_id: 'a1' }).success, true);
  assert.equal(AGENT_REGISTRY_TOOL_DEFS.list_agents.inputSchema.safeParse({}).success, true);
});
