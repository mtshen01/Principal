/**
 * 子代理句柄端到端接线（P1-7，spec `docs/superpowers/specs/2026-10-16-agent-registry-and-handles-design.md`）。
 *
 * 单元测试（`capabilities/agent-registry.test.js`）用假 `runTurn` 钉住句柄语义；本文件钉的是**接线**：
 * 真 run-openai + 真策略门 + 真工具装配，只把最外层的模型调用换成脚本，验证
 *  ① `Task({background:true})` 真的后台跑（父模型不被阻塞，能继续调别的工具）；
 *  ② `wait_agent` 取回的确实是子代理的结论（不是「仍在运行」的空话）；
 *  ③ `list_agents` 看得到状态与摘要；
 *  ④ 状态迁移真的写进了 run-journal（回放 reducer 的输入）；
 *  ⑤ 关掉「给子代理发消息」→ 后台派发降级为同步（没有取回手段就不该后台跑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'run-openai-agents-'));
process.env.APP_DATA_DIR = DATA;

const providers = await import('../../providers/index.js');
const { runAgentLoop } = await import('../../providers/agent-loop.js');
const { startOpenAiRun } = await import('./run-openai.js');
const { startRunDurability } = await import('./run-durability.js');
const { createRun } = await import('../../store/runs.js');
const { readRunEvents } = await import('../../store/run-journal.js');
const { setBuiltinMcp, setRepoMapEnabled, addToken, setUiPrefs } = await import('../../store/settings.js');

const SUBAGENT_MARK = '只读探查子代理';

/** 脚本步骤 → 假模型（真 provider 的返回值形状：stream + finished） */
const step = (s) => ({
  stream: (async function* () {
    if (s.text) yield { type: 'text', text: s.text };
    for (const c of s.toolCalls || []) yield { type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input };
  })(),
  finished: Promise.resolve({ finishReason: s.finishReason || 'stop', toolCalls: s.toolCalls || [], responseMessages: s.responseMessages || [] }),
});

const toolStep = (toolCallId, toolName, input) => ({
  finishReason: 'tool-calls',
  toolCalls: [{ toolCallId, toolName, input }],
  responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input }] }],
});

const textStep = (text) => ({ text, responseMessages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });

let MAIN_SCRIPT = [];
let SUB_SCRIPT = [];
let toolResults = [];
/** 各角色模型实际收到的发送面（断言「被拒/被禁用的调用没有执行」靠它——拒绝发生在 canUseTool，不到 executeTool） */
let seenCalls = { main: [], sub: [] };

/** 同 id 覆盖 provider：按「是不是子代理调用」分流脚本；记录每次工具结果（断言取回的结论） */
providers.register({
  id: 'openai-compat',
  capabilities: {},
  run(input, hooks) {
    const head = JSON.stringify(input.messages?.[0]?.content ?? '');
    const isSub = head.includes(SUBAGENT_MARK);
    let n = 0;
    const script = isSub ? SUB_SCRIPT : MAIN_SCRIPT;
    const executeTool = async (name, arg) => {
      const out = await input.executeTool(name, arg);
      toolResults.push({ name, out: String(out ?? '') });
      return out;
    };
    const done = runAgentLoop(
      {
        messages: input.messages,
        modelRun: (msgs) => {
          seenCalls[isSub ? 'sub' : 'main'].push(JSON.parse(JSON.stringify(msgs ?? [])));
          return step(script[n++] || { finishReason: 'stop', responseMessages: [] });
        },
        executeTool,
        signal: input.abortController?.signal,
      },
      hooks,
    );
    return { done, abort: () => input.abortController?.abort?.() };
  },
});

async function waitDone(run, ms = 8000) {
  const t0 = Date.now();
  while (run.status === 'running' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(run.status, 'running', 'run 应在时限内收尾');
}

test.before(() => {
  setBuiltinMcp('context7', { enabled: false });
  setRepoMapEnabled(false);
  addToken('测试模型', 'sk-agents', 'openai-compat', { baseURL: 'http://127.0.0.1:9/v1', model: 'test-model' });
  startRunDurability();
});

test('后台派发 → 父模型继续走 → wait_agent 取回结论 → list_agents + journal 留痕', async () => {
  const tokens = (await import('../../store/settings.js')).getTokens();
  const credId = tokens[tokens.length - 1].id;
  toolResults = [];
  SUB_SCRIPT = [textStep('子代理结论：支付回调已找到 3 处调用（pay.js:12 / order.js:88 / refund.js:41）')];
  MAIN_SCRIPT = [
    toolStep('t1', 'Task', { description: '查支付回调', prompt: '查清支付回调在哪几处被调用', background: true }),
    toolStep('t2', 'wait_agent', { agent_id: 'a1', timeout_ms: 5000 }),
    toolStep('t3', 'list_agents', {}),
    textStep('已汇总：3 处调用'),
  ];
  const run = createRun();
  await startOpenAiRun(run, { prompt: '查支付回调', model: 'test-model', credId, cwd: DATA, convId: 'c_agents', requestId: 'rq_agents' });
  await waitDone(run);
  assert.equal(run.status, 'done');

  // ① 后台派发：Task 立即返回 agent_id，没有被阻塞到子代理结束
  const taskOut = toolResults.find((r) => r.name === 'Task');
  assert.match(taskOut.out, /已后台派发子代理 a1/);
  assert.match(taskOut.out, /wait_agent/);

  // ② wait_agent 取回的确实是子代理的结论
  const waitOut = toolResults.find((r) => r.name === 'wait_agent');
  assert.match(waitOut.out, /子代理结论：支付回调已找到 3 处调用/);

  // ③ list_agents 看得到状态与摘要
  const listOut = toolResults.find((r) => r.name === 'list_agents');
  assert.match(listOut.out, /本轮子代理（1 个）/);
  assert.match(listOut.out, /已完成/);
  assert.match(listOut.out, /子代理结论：支付回调已找到 3 处调用/);

  // ④ 状态迁移进 journal（回放 reducer 的输入；pending → running → completed）
  const agentEvents = readRunEvents(run.id).filter((e) => e.type === 'agent_status');
  assert.deepEqual(agentEvents.map((e) => e.data.status), ['pending', 'running', 'completed']);
  assert.equal(agentEvents[0].data.agentId, 'a1');
  assert.equal(agentEvents[0].data.role, 'explorer');
  assert.match(agentEvents.at(-1).data.summaryHead, /子代理结论/);
});

test('关掉「给子代理发消息」→ 后台派发降级为同步等结果，且工具真的不装', async () => {
  const tokens = (await import('../../store/settings.js')).getTokens();
  const credId = tokens[tokens.length - 1].id;
  setUiPrefs({ disabledTools: ['send_message'] });
  toolResults = [];
  SUB_SCRIPT = [textStep('子代理结论：同步跑的')];
  MAIN_SCRIPT = [toolStep('t1', 'Task', { description: '查', prompt: '查', background: true }), textStep('done')];
  const run = createRun();
  await startOpenAiRun(run, { prompt: '查', model: 'test-model', credId, cwd: DATA, convId: 'c_agents_off', requestId: 'rq_agents_off' });
  await waitDone(run);
  assert.equal(run.status, 'done');
  // 降级：Task 直接返回结论（而不是 ack），活动行如实说明
  const taskOut = toolResults.find((r) => r.name === 'Task');
  assert.equal(taskOut.out, '子代理结论：同步跑的');
  assert.ok(
    run.activities.some((a) => a.includes('后台派发一并停用')),
    `活动行应说明降级原因，实际：${run.activities.join(' | ')}`,
  );
  // 被禁用的工具不装（模型看不到 send_message）；journal 里仍有子代理事实
  const agentEvents = readRunEvents(run.id).filter((e) => e.type === 'agent_status');
  assert.deepEqual(agentEvents.map((e) => e.data.status), ['pending', 'running', 'completed']);
  setUiPrefs({ disabledTools: [] });
});

test('禁用后硬调子代理工具 → 策略门拒绝并给出指路文案（绝不静默执行）', async () => {
  const tokens = (await import('../../store/settings.js')).getTokens();
  const credId = tokens[tokens.length - 1].id;
  setUiPrefs({ disabledTools: ['list_agents'] });
  toolResults = [];
  seenCalls = { main: [], sub: [] };
  SUB_SCRIPT = [];
  MAIN_SCRIPT = [toolStep('t1', 'list_agents', {}), textStep('done')];
  const run = createRun();
  await startOpenAiRun(run, { prompt: '列一下', model: 'test-model', credId, cwd: DATA, convId: 'c_agents_deny', requestId: 'rq_agents_deny' });
  await waitDone(run);
  // 拒绝发生在策略门（canUseTool），所以工具执行体压根没被调用——模型看到的是可读拒绝文案
  assert.equal(toolResults.some((r) => r.name === 'list_agents'), false, '被禁用的工具不得执行');
  const toolMsg = seenCalls.main.at(-1)?.find((m) => m.role === 'tool');
  assert.match(JSON.stringify(toolMsg), /list_agents」已被用户关闭/);
  setUiPrefs({ disabledTools: [] });
});

test.after(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
});
