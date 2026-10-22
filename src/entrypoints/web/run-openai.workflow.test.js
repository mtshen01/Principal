/**
 * 自定义模型 Ultracode（内置 Workflow 编排）的入口级集成：
 *  - 授权位真的决定工具是否存在（`ultracode:false` 时模型即使硬调也被 fail-closed 拒掉）；
 *  - 编排真的并行跑只读子代理（同一凭证/模型，工具集只读、禁递归），进度进活动转录；
 *  - 各子任务结论被汇总成一条工具结果回给主模型（主模型据此对用户总结）。
 *
 * 模型侧沿用 run-openai.resume.test.js 的「注册表同 id 覆盖」范式：内部仍跑真 agent-loop +
 * 真内置工具装配，只把最外层的模型调用换成脚本（假 provider 按 system 提示词区分主 run 与子代理）。
 * 隔离：APP_DATA_DIR → 临时目录；全部动态 import。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'run-openai-workflow-'));
process.env.APP_DATA_DIR = DATA;

const providers = await import('../../providers/index.js');
const { runAgentLoop } = await import('../../providers/agent-loop.js');
const { startOpenAiRun } = await import('./run-openai.js');
const { startRunDurability } = await import('./run-durability.js');
const { clearMessages } = await import('../../store/conv-messages.js');
const { createRun } = await import('../../store/runs.js');
const { setBuiltinMcp, setRepoMapEnabled, addToken } = await import('../../store/settings.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORKFLOW_INPUT = {
  name: '支付模块审查',
  goal: '找出未处理的 Promise',
  phases: [
    {
      title: '并行调研',
      tasks: [
        { title: '查 store', prompt: '检查 src/store 的未处理 Promise' },
        { title: '查 plugins', prompt: '检查 src/plugins 的未处理 Promise' },
      ],
    },
    { title: '交叉验证', tasks: [{ title: '复核', prompt: '复核上面两处的结论' }] },
  ],
};

/** 假 provider：同 id 覆盖真实现，内部跑真 agent-loop（含真 executeTool 分派） */
let scriptedModel = () => ({ stream: (async function* () {})(), finished: Promise.resolve({ finishReason: 'stop' }) });
let allInputs = [];
providers.register({
  id: 'openai-compat',
  capabilities: {},
  run(input, hooks) {
    allInputs.push(input);
    const done = runAgentLoop(
      { messages: input.messages, modelRun: scriptedModel, executeTool: input.executeTool, signal: input.abortController?.signal },
      hooks,
    );
    return { done, abort: () => {} };
  },
});

const textStep = (text) => ({
  stream: (async function* () {
    yield { type: 'text', text };
  })(),
  finished: Promise.resolve({
    finishReason: 'stop',
    toolCalls: [],
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
  }),
});
const toolStep = (input) => ({
  stream: (async function* () {
    yield { type: 'tool-call', toolCallId: 'w1', toolName: 'Workflow', input };
  })(),
  finished: Promise.resolve({
    finishReason: 'tool-calls',
    toolCalls: [{ toolCallId: 'w1', toolName: 'Workflow', input }],
    responseMessages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'w1', toolName: 'Workflow', input }] }],
  }),
});

const isSubagentCall = (input) => String(input.messages?.[0]?.content || '').includes('只读探查子代理');
const subagentInputs = () => allInputs.filter(isSubagentCall);
const mainInputs = () => allInputs.filter((i) => !isSubagentCall(i));
// 主模型看到的工具结果（role=tool 的消息正文）。
// 只能从 **modelRun 收到的 convo** 里抓：`input.messages` 是入口传进去的原始数组，
// agent-loop 内部只 slice 一份自己追加，不回写 → 那里永远看不到 tool 结果。
let toolMsgs = [];
const captureToolMsgs = (messages) => {
  for (const m of messages || []) {
    if (m.role === 'tool') toolMsgs.push(JSON.stringify(m));
  }
};
const toolResults = () => toolMsgs;

let CRED_ID = null;
test.before(() => {
  setBuiltinMcp('context7', { enabled: false });
  setRepoMapEnabled(false);
  const tokens = addToken('测试模型', 'sk-test', 'openai-compat', { baseURL: 'http://127.0.0.1:9/v1', model: 'test-model' });
  CRED_ID = tokens[tokens.length - 1].id;
  startRunDurability();
});

async function waitDone(run, ms = 5000) {
  const t0 = Date.now();
  while (run.status === 'running' && Date.now() - t0 < ms) await sleep(10);
  assert.notEqual(run.status, 'running', 'run 应在时限内收尾');
}

function reset() {
  allInputs = [];
  toolMsgs = [];
}

test('ultracode:true → 注入 Workflow 工具 + 授权说明；阶段并行跑只读子代理，结论汇总回主模型', async () => {
  clearMessages('c_wf_on');
  reset();
  let mainCalls = 0;
  let subLive = 0;
  let subPeak = 0;
  scriptedModel = (messages) => {
    if (String(messages[0]?.content || '').includes('只读探查子代理')) {
      const prompt = String(messages[messages.length - 1]?.content || '');
      subLive += 1;
      subPeak = Math.max(subPeak, subLive);
      return {
        stream: (async function* () {
          await sleep(20);
          yield { type: 'text', text: `结论：${prompt.slice(0, 24)}` };
        })(),
        finished: (async () => {
          await sleep(20);
          subLive -= 1;
          return {
            finishReason: 'stop',
            toolCalls: [],
            responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '结论' }] }],
            usage: { inputTokens: 11, outputTokens: 7 },
          };
        })(),
      };
    }
    mainCalls += 1;
    captureToolMsgs(messages);
    return mainCalls === 1 ? toolStep(WORKFLOW_INPUT) : textStep('汇总完成');
  };

  const run = createRun();
  run.convId = 'c_wf_on';
  await startOpenAiRun(run, {
    prompt: '用两个子代理查未处理的 Promise',
    model: 'test-model',
    credId: CRED_ID,
    cwd: DATA,
    convId: 'c_wf_on',
    requestId: 'rq_wf_on',
    mode: 'bypassPermissions',
    ultracode: true,
  });
  await waitDone(run);

  // ① 工具与授权都到位
  const main0 = mainInputs()[0];
  assert.ok(main0.tools.Workflow, '开了 Ultracode 才有 Workflow 工具');
  assert.match(String(main0.messages[0].content), /Ultracode/);
  assert.match(String(main0.messages[0].content), /Workflow/);

  // ② 三个子代理，每个都带上编排总目标；工具集只读、不含 Task/Workflow（禁递归）
  const subs = subagentInputs();
  assert.equal(subs.length, 3, '2 个并行 + 1 个复核');
  for (const s of subs) {
    assert.match(String(s.messages[1].content), /总目标：找出未处理的 Promise/);
    assert.ok(s.tools.Read && s.tools.Grep, '子代理是只读集');
    assert.equal(s.tools.Write, undefined);
    assert.equal(s.tools.Bash, undefined);
    assert.equal(s.tools.Task, undefined);
    assert.equal(s.tools.Workflow, undefined);
  }
  assert.ok(subPeak >= 2, `同阶段子代理应并行（实测峰值 ${subPeak}）`);

  // ③ 进度进活动转录
  const acts = run.activities.join('\n');
  assert.match(acts, /⚡ 工作流\(支付模块审查\) · 2 阶段\/3 子任务 启动：找出未处理的 Promise/);
  assert.match(acts, /阶段 1\/2「并行调研」启动：2 个子任务并行/);
  assert.match(acts, /阶段 1\/2 完成：2\/2 个子任务给出结论/);
  assert.match(acts, /✔ 子任务 1\/2「查 store」完成/);
  assert.match(acts, /完成：3 个成功/);

  // ④ 汇总回主模型：阶段标题 + 每条结论 + 明确的「别把缺口当已查清」
  const joined = toolResults().join('\n');
  assert.match(joined, /## 工作流\(支付模块审查\) · 2 阶段\/3 子任务 结果/);
  assert.match(joined, /### 阶段：并行调研/);
  assert.match(joined, /结论：/);
  assert.match(joined, /### 阶段：交叉验证/);
  assert.match(joined, /有失败或缺口要如实说明/);

  // ⑤ 主模型收尾
  assert.match(run.text, /汇总完成/);
});

test('ultracode:false → 不注入工具、不加授权说明；模型硬调也 fail-closed（不起任何子代理）', async () => {
  clearMessages('c_wf_off');
  reset();
  let mainCalls = 0;
  scriptedModel = (messages) => {
    if (String(messages[0]?.content || '').includes('只读探查子代理')) return textStep('不该被叫到');
    mainCalls += 1;
    captureToolMsgs(messages);
    return mainCalls === 1 ? toolStep(WORKFLOW_INPUT) : textStep('已按普通路径处理');
  };

  const run = createRun();
  run.convId = 'c_wf_off';
  await startOpenAiRun(run, {
    prompt: '随便问问',
    model: 'test-model',
    credId: CRED_ID,
    cwd: DATA,
    convId: 'c_wf_off',
    requestId: 'rq_wf_off',
    mode: 'bypassPermissions',
  });
  await waitDone(run);

  const main0 = mainInputs()[0];
  assert.equal(main0.tools.Workflow, undefined, '没授权就不该有 Workflow 工具');
  assert.doesNotMatch(String(main0.messages[0].content), /Ultracode/);
  assert.equal(subagentInputs().length, 0, '不得起任何子代理');
  assert.match(toolResults().join('\n'), /本轮未开启 Ultracode/);
  assert.match(run.text, /已按普通路径处理/);
});

test('工具被用户禁用（disabledTools 含 Workflow）时：即使 run 带授权位也退回普通路径，并明确告知', async () => {
  const { setUiPrefs, getUiPrefs } = await import('../../store/settings.js');
  const saved = getUiPrefs();
  setUiPrefs({ disabledTools: [...(saved.disabledTools || []), 'Workflow'] });
  try {
    clearMessages('c_wf_disabled');
    reset();
    let mainCalls = 0;
    scriptedModel = () => {
      mainCalls += 1;
      return textStep('普通回复');
    };
    const run = createRun();
    run.convId = 'c_wf_disabled';
    await startOpenAiRun(run, {
      prompt: '你好',
      model: 'test-model',
      credId: CRED_ID,
      cwd: DATA,
      convId: 'c_wf_disabled',
      requestId: 'rq_wf_disabled',
      mode: 'bypassPermissions',
      ultracode: true,
    });
    await waitDone(run);
    assert.equal(mainInputs()[0].tools.Workflow, undefined);
    assert.match(run.activities.join('\n'), /Ultracode 已开启，但「工作流」工具被禁用/);
  } finally {
    setUiPrefs({ disabledTools: saved.disabledTools || [] });
  }
});
