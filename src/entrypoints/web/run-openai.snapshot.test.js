/**
 * 发送面请求快照（P1-12，spec `docs/superpowers/specs/2026-10-11-request-snapshot-and-run-replay-design.md`）：
 * 经假 provider 包装 modelRun，逐次捕获「模型实际收到的 messages + 本轮工具名集合」，与 JSON 快照
 * 逐字比对——把 P0-①②③ 的上下文组装（normalize / 压缩 / system 挂摘要）锁成金标准。
 *
 * 场景：s1 多步工具循环 / s2 脏历史 normalize（前拉+合成+剪空+截断）/ s3 压缩触发（摘要+主调用）/
 * s4 plan 注入（P1-9：每轮都注入；面板只在续跑时续挂，新起一轮不预挂）＋ TodoWrite 落盘与损坏计划
 * 文件 fail-open（P1-9）/ s5 步边界 steer 注入（P1-10）。
 * 快照：`__snapshots__/run-openai-requests.json`；
 * 重录：`UPDATE_SNAPSHOTS=1 node --test src/entrypoints/web/run-openai.snapshot.test.js`。
 *
 * 隔离范式同 run-openai.resume.test.js：临时 APP_DATA_DIR + 动态 import + 同 id 覆盖假 provider；
 * 真 run-openai / 真 normalize / 真压缩，只把最外层模型调用换成脚本。快照的跨平台确定性由
 * normalize 规则（拍板 #3）保证：临时路径 → <DATA>、平台名 → <OS>、时间戳 → <TS>、超长串压缩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'run-openai-snapshot-'));
process.env.APP_DATA_DIR = DATA;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, '__snapshots__', 'run-openai-requests.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAPSHOT_HOWTO = 'UPDATE_SNAPSHOTS=1 node --test src/entrypoints/web/run-openai.snapshot.test.js';

const providers = await import('../../providers/index.js');
const { runAgentLoop } = await import('../../providers/agent-loop.js');
const { startOpenAiRun, resumeOpenAiRun } = await import('./run-openai.js');
const { startRunDurability } = await import('./run-durability.js');
const { appendMessages, clearMessages, getSummary } = await import('../../store/conv-messages.js');
const { createRun, holdMsg } = await import('../../store/runs.js');
const { readRunEvents } = await import('../../store/run-journal.js');
const { setBuiltinMcp, setRepoMapEnabled, addToken } = await import('../../store/settings.js');
const { setConvTodos, getConvTodos, clearAllConvTodos } = await import('../../store/conv-todos.js');

// ---- 假 provider：同 id 覆盖；包装 modelRun 捕获每次调用的发送面 ----
let scriptedModel = null;
let caps = []; // [{ tools: string[], calls: messages[][] }] —— 每次 provider.run（含摘要调用）一组
providers.register({
  id: 'openai-compat',
  capabilities: {},
  run(input, hooks) {
    const entry = { tools: input.tools ? Object.keys(input.tools).sort() : [], calls: [] };
    caps.push(entry);
    const capturingModel = (messages, opts) => {
      entry.calls.push(JSON.parse(JSON.stringify(messages ?? [])));
      return scriptedModel(messages, opts);
    };
    const done = runAgentLoop(
      {
        messages: input.messages,
        modelRun: capturingModel,
        executeTool: input.executeTool,
        signal: input.abortController?.signal,
      },
      hooks,
    );
    return { done, abort: () => {} };
  },
});

function makeScript(steps) {
  let n = 0;
  return () => {
    const s = steps[n++] || { finishReason: 'stop', responseMessages: [] };
    return {
      stream: (async function* () {
        if (s.text) yield { type: 'text', text: s.text };
        for (const c of s.toolCalls || []) {
          yield { type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input };
        }
      })(),
      finished: Promise.resolve({
        finishReason: s.finishReason || 'stop',
        toolCalls: s.toolCalls || [],
        responseMessages: s.responseMessages || [],
      }),
    };
  };
}

const textStep = (text) => ({ text, responseMessages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });

async function waitDone(run, ms = 3000) {
  const t0 = Date.now();
  while (run.status === 'running' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(run.status, 'running', 'run 应在时限内收尾');
}

// ---- normalize（拍板 #3）：临时目录 / 平台名 / 时间戳 / 超长字符串（>4000 压缩为 len+头尾）----
function normalizeValue(v) {
  if (typeof v === 'string') {
    let s = v.split(DATA).join('<DATA>');
    s = s.replace(/<DATA>\\/g, '<DATA>/');
    s = s.replace(/\b(Windows|macOS|Linux)\b/g, '<OS>');
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>');
    if (s.length > 4000) return { $len: s.length, head: s.slice(0, 120), tail: s.slice(-120) };
    return s;
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalizeValue(x);
    return out;
  }
  return v;
}

const snapshotOf = () => ({ runs: caps.map((e) => ({ tools: e.tools, calls: e.calls.map((m) => normalizeValue(m)) })) });

// ---- 快照读写：缺名或 UPDATE 时写入；否则逐字比对，失败信息带重录命令 ----
let _snaps = null;
function loadSnaps() {
  if (_snaps) return _snaps;
  _snaps = fs.existsSync(SNAPSHOT_FILE) ? JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) : {};
  return _snaps;
}
function assertSnapshot(name, value) {
  const snaps = loadSnaps();
  if (UPDATE || !(name in snaps)) {
    snaps[name] = value;
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snaps, null, 2) + '\n');
    console.log(`[snapshot] 写入 ${name}${UPDATE ? '（UPDATE_SNAPSHOTS=1）' : '（首次）'}`);
    return;
  }
  try {
    assert.deepEqual(value, snaps[name]);
  } catch (e) {
    throw new Error(`${e.message}\n\n[snapshot] 快照不符：${name}。确认为预期变更后重录：\n  ${SNAPSHOT_HOWTO}`);
  }
}

let CRED_ID = null;
test.before(() => {
  // 关掉外部依赖：内置 MCP（会拉 npx 子进程）与仓库地图（会扫盘）
  setBuiltinMcp('context7', { enabled: false });
  setRepoMapEnabled(false);
  const tokens = addToken('测试模型', 'sk-test', 'openai-compat', { baseURL: 'http://127.0.0.1:9/v1', model: 'test-model' });
  CRED_ID = tokens[tokens.length - 1].id;
  startRunDurability(); // 激活 journal sink（幂等）
  fs.writeFileSync(path.join(DATA, 'hello.txt'), 'hello from snapshot');
});

test('快照 s1：多步工具循环（真 Read 执行后带结果续步）', async () => {
  const convId = 'c_snap_steps';
  clearMessages(convId);
  caps = [];
  const readInput = { file_path: path.join(DATA, 'hello.txt') };
  scriptedModel = makeScript([
    {
      toolCalls: [{ toolCallId: 'sc1', toolName: 'Read', input: readInput }],
      finishReason: 'tool-calls',
      responseMessages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'sc1', toolName: 'Read', input: readInput }] },
      ],
    },
    textStep('快照读完'),
  ]);
  const run = createRun();
  await startOpenAiRun(run, { prompt: '读 hello.txt', model: 'test-model', credId: CRED_ID, cwd: DATA, convId, requestId: 'rq_snap_1' });
  await waitDone(run);

  assert.equal(run.status, 'done');
  assert.equal(caps.length, 1, '一次 provider.run 覆盖两步');
  assert.equal(caps[0].calls.length, 2, '两次模型调用都捕获');
  assert.deepEqual(caps[0].calls[0].map((m) => m.role), ['system', 'user']);
  assert.deepEqual(caps[0].calls[1].map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.ok(JSON.stringify(caps[0].calls[1][3]).includes('hello from snapshot'), '第 2 次调用带真实工具结果');
  assertSnapshot('s1_multi_step_tool_loop', snapshotOf());
});

test('快照 s2：脏历史 normalize（脱档前拉 + 悬空合成 + 剪空 + 超长截断）', async () => {
  const convId = 'c_snap_dirty';
  clearMessages(convId);
  caps = [];
  const huge = `超长背景数据：${'x'.repeat(130_000)}`;
  appendMessages(convId, [
    { role: 'user', content: '背景：一批数据' },
    { role: 'user', content: huge },
    { role: 'user', content: '先读 a.txt' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'sn1', toolName: 'Read', input: { path: 'a.txt' } }] },
    { role: 'assistant', content: [] },
    { role: 'user', content: '继续' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'sn1', toolName: 'Read', output: { type: 'text', value: 'a.txt 的内容' } }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'sn2', toolName: 'Read', input: { path: 'b.txt' } }] },
  ]);
  scriptedModel = makeScript([textStep('已继续')]);

  const run = createRun();
  await resumeOpenAiRun(run, { convId, runId: 'run_snap_dirty', model: 'test-model', credId: CRED_ID, cwd: DATA });
  await waitDone(run);

  assert.equal(run.status, 'done');
  const sent = caps[0].calls[0];
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'user', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool']);
  assert.equal(sent[5].content[0].output.value, 'a.txt 的内容', '脱档真实结果前拉到调用后');
  assert.match(sent.at(-1).content[0].output.value, /未执行/, '尾部悬空调用合成占位');
  assert.ok(typeof sent[2].content === 'string' && sent[2].content.length >= 120_000, '超长消息被中间截断');
  assert.match(sent[2].content, /（略 \d+ 字符）/);
  assertSnapshot('s2_dirty_history_normalized', snapshotOf());
});

test('快照 s3：压缩触发（摘要调用 + system 挂摘要的主调用）', async () => {
  const convId = 'c_snap_compact';
  clearMessages(convId);
  caps = [];
  const seed = Array.from({ length: 220 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i % 2 ? 'a' : 'u'}${i}` }));
  appendMessages(convId, seed);
  scriptedModel = makeScript([textStep('摘要快照'), textStep('完成')]);

  const run = createRun();
  await startOpenAiRun(run, { prompt: '继续快照', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  assert.equal(run.status, 'done');
  const summary = getSummary(convId);
  assert.ok(summary && summary.covered === 120, `压缩切点确定性（actual=${summary && summary.covered}）`);
  assert.equal(caps.length, 2, '摘要调用 + 主调用各一组');
  assert.deepEqual(caps[0].tools, [], '摘要调用不带工具');
  assert.match(caps[0].calls[0][0].content, /会话压缩器/);
  assert.match(caps[0].calls[0][1].content, /【新增需要并入摘要的对话】/);
  const main = caps[1].calls[0];
  assert.match(main[0].content, /## 历史摘要/);
  assert.match(main[0].content, /摘要快照/);
  assert.equal(main.length, 1 + (221 - 120), '模型视角 = system + 摘要边界起的近期');
  assert.equal(main[1].content, 'u120', '视图起点恰为摘要覆盖边界');
  assertSnapshot('s3_compaction_summary_and_main', snapshotOf());
});

test('快照 s4：plan 跨轮注入（系统提示带任务清单；新起一轮不预挂面板）', async () => {
  const convId = 'c_snap_plan';
  clearMessages(convId);
  setConvTodos(
    convId,
    [
      { content: '修复登录流程', status: 'in_progress', activeForm: '正在修复登录流程' },
      { content: '写回归测试', status: 'pending' },
      { content: '定位问题', status: 'completed' },
    ],
    { runId: 'run_plan_prev' },
  );
  caps = [];
  scriptedModel = makeScript([textStep('收到，继续')]);
  const run = createRun();
  await startOpenAiRun(run, { prompt: '继续', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  assert.equal(run.status, 'done');
  // 注入照旧（清单是「世界状态」，模型每轮都该看到）；但**面板不预挂**：这张旧清单不是本轮的产出，
  // 一上来就挂会让人以为上一轮的内容被复制进了新一轮（2026-10-16 用户报告）。
  // 本轮模型一动清单（下一个用例的 TodoWrite）面板就出现。
  assert.deepEqual(run.todos, [], '新起一轮不预挂上一轮的清单');
  const sys = caps[0].calls[0][0].content;
  assert.match(sys, /## 任务清单/);
  assert.match(sys, /\[>\] 修复登录流程（进行中：正在修复登录流程）/);
  assert.match(sys, /\[x\] 定位问题/);
  assert.match(sys, /\[ \] 写回归测试/);
  assertSnapshot('s4_plan_injected_system', snapshotOf());
});

test('续跑（检查点恢复）才续挂清单面板：P1-9 要修的「重启/续跑后面板空白」仍成立', async () => {
  const convId = 'c_snap_plan_resume';
  clearMessages(convId);
  setConvTodos(
    convId,
    [
      { content: '修复登录流程', status: 'in_progress', activeForm: '正在修复登录流程' },
      { content: '写回归测试', status: 'pending' },
    ],
    { runId: 'run_plan_prev' },
  );
  // 续跑前提：检查点非空且末尾不是完整回复（末尾是 assistant 会被判「无需续跑」直接终结）
  appendMessages(convId, [{ role: 'user', content: '继续' }]);
  caps = [];
  scriptedModel = makeScript([textStep('收到，继续')]);
  const run = createRun();
  await resumeOpenAiRun(run, {
    convId,
    runId: 'run_plan_dead',
    model: 'test-model',
    credId: CRED_ID,
    cwd: DATA,
    resumeAttempt: 1,
  });
  await waitDone(run);

  assert.equal(run.status, 'done');
  assert.deepEqual(
    run.todos.map((t) => t.content),
    ['修复登录流程', '写回归测试'],
    '续跑：面板续挂（用户重开页面/进程重启后仍看得到进度）',
  );
  assert.match(caps[0].calls[0][0].content, /## 任务清单/);
});

test('TodoWrite → conv-todos 落盘（下一轮的注入源），面板同步', async () => {
  const convId = 'c_snap_plan_write';
  clearMessages(convId);
  caps = [];
  const todos = [
    { content: '第一步', status: 'completed' },
    { content: '第二步', status: 'in_progress', activeForm: '正在做第二步' },
  ];
  scriptedModel = makeScript([
    {
      toolCalls: [{ toolCallId: 'td1', toolName: 'TodoWrite', input: { todos } }],
      finishReason: 'tool-calls',
      responseMessages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'td1', toolName: 'TodoWrite', input: { todos } }] },
      ],
    },
    textStep('清单已更新'),
  ]);
  const run = createRun();
  await startOpenAiRun(run, { prompt: '开工', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  assert.equal(run.status, 'done');
  const persisted = getConvTodos(convId);
  assert.ok(persisted, 'TodoWrite 快照已落盘');
  assert.deepEqual(persisted.todos.map((t) => t.content), ['第一步', '第二步']);
  assert.equal(persisted.todos[1].activeForm, '正在做第二步');
  assert.equal(persisted.runId, run.id);
  assert.deepEqual(run.todos.map((t) => t.content), ['第一步', '第二步'], '面板同步');
});

test('损坏 conv-todos.json 不挡起跑（fail-open：按无计划继续）', async () => {
  const convId = 'c_snap_plan_corrupt';
  clearMessages(convId);
  fs.writeFileSync(path.join(DATA, 'conv-todos.json'), '{broken');
  caps = [];
  scriptedModel = makeScript([textStep('收到')]);
  const run = createRun();
  await startOpenAiRun(run, { prompt: '继续', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  assert.equal(run.status, 'done', '计划文件损坏不影响起跑');
  assert.deepEqual(run.todos, [], '无计划可恢复');
  assert.equal(caps[0].calls[0][0].content.includes('## 任务清单'), false, '不注入空/坏清单');
  clearAllConvTodos(); // 复原因子，避免影响后续用例
});

test('快照 s5：步边界 steer（首轮工具往返期间插话 → 第二次模型调用带 user 消息，journal 记 via=step）', async () => {
  const convId = 'c_snap_steer';
  clearMessages(convId);
  caps = [];
  const readInput = { file_path: path.join(DATA, 'hello.txt') };
  const base = makeScript([
    {
      toolCalls: [{ toolCallId: 'st1', toolName: 'Read', input: readInput }],
      finishReason: 'tool-calls',
      responseMessages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'st1', toolName: 'Read', input: readInput }] },
      ],
    },
    textStep('好，直接给结论'),
  ]);
  const run = createRun();
  let injected = false;
  scriptedModel = (messages, opts) => {
    if (!injected) {
      injected = true;
      holdMsg(run, '别读了，直接说结论'); // 首轮模型调用进行中，用户插话（持有区）
    }
    return base(messages, opts);
  };
  await startOpenAiRun(run, { prompt: '读 hello.txt 再总结', model: 'test-model', credId: CRED_ID, cwd: DATA, convId });
  await waitDone(run);

  assert.equal(run.status, 'done');
  assert.equal(run.capabilities.steer, true, 'openai 起跑即置 steer 能力位（P1-10）');
  assert.equal(run.capabilities.steerMode, 'step');
  assert.equal(caps[0].calls.length, 2, '插话不产生第三个 run/请求：就在本轮步边界续答');
  assert.deepEqual(caps[0].calls[1].map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user'], '第二次调用的发送面含注入的插话');
  assert.equal(caps[0].calls[1].at(-1).content, '别读了，直接说结论');
  assert.equal(run.heldMsgs.length, 0, '插话已被步边界取走');
  const consumed = readRunEvents(run.id).filter((e) => e.type === 'steer_consumed');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].data.via, 'step');
  assert.equal(consumed[0].data.msgIds.length, 1);
  assertSnapshot('s5_step_steer_injection', snapshotOf());
});
