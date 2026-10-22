/**
 * routes-run 的用户输入埋点单测（记忆库数据采集层）。
 *
 * 只验证「哪些请求会被记进原始日志、记成什么样」这一件事 —— 这正是最容易出错的地方：
 * 起跑/插话两个接口同时也是程序化发送（自动开发提示词/复盘总结）的通道，
 * 一旦把系统派发的提示词记进去，提炼层就被永久污染了。
 *
 * 起跑用例一律走 provider='openai-compat' 且不配任何凭证：埋点在 provider 分支之前执行，
 * 而 startOpenAiRun 会因取不到凭证立刻 failRun —— 既覆盖到埋点，又不会真的发起模型调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-routes-'));
const DATA_DIR = process.env.APP_DATA_DIR;
const { handleRunStart, handleRunSend, handleRunAttach, handleRunMsgWithdraw, handleRunMsgNow, handleRunPending, handleRunQueueList } =
  await import('./routes-run.js');
const {
  createRun,
  getRun,
  finishRun,
  listFollowUps,
  markFollowUpStarted,
  clearFollowUps,
} = await import('../../store/runs.js');
const { readUserLog, userLogFile } = await import('../../store/user-log.js');
const { addPending } = await import('../../store/pending-resume.js');
const { claimSubmission, bindSubmission } = await import('../../store/submissions.js');

let server, base;
test.before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/start') return handleRunStart(req, res);
    if (url.pathname === '/send') return handleRunSend(req, res);
    if (url.pathname === '/msg/withdraw') return handleRunMsgWithdraw(req, res);
    if (url.pathname === '/msg/now') return handleRunMsgNow(req, res);
    if (url.pathname === '/api/run/queue') return handleRunQueueList(url, res);
    if (url.pathname === '/pending') return handleRunPending(res);
    if (url.pathname === '/api/run') return handleRunAttach(url, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 起跑一次并立刻收尾（不留看门狗定时器拖住测试进程） */
async function start(body) {
  const r = await post('/start', { provider: 'openai-compat', model: 'gpt-x', ...body });
  const run = r.json?.runId && getRun(r.json.runId);
  if (run) finishRun(run);
  return r;
}

/** 清空日志，让每个用例从零开始断言 */
function resetLog() {
  fs.writeFileSync(userLogFile(), '');
}
const logged = () => readUserLog().entries;

test('起跑：带 userTyped 的请求记一条 send，并带上会话/目录/模型上下文', async () => {
  resetLog();
  const r = await start({ prompt: '以后注释一律用中文', cwd: DATA_DIR, session: 'sess-1', convId: 'c1' });
  assert.equal(r.status, 200);
  assert.deepEqual(logged(), []); // 没打标记 → 不记（下面才是带标记的那次）

  await start({ prompt: '以后注释一律用中文', cwd: DATA_DIR, session: 'sess-1', convId: 'c1', userTyped: true });
  const [e] = logged();
  assert.equal(e.text, '以后注释一律用中文');
  assert.equal(e.source, 'web');
  assert.equal(e.kind, 'send');
  assert.equal(e.convId, 'c1');
  assert.equal(e.sessionId, 'sess-1');
  assert.equal(e.cwd, DATA_DIR);
  assert.equal(e.model, 'gpt-x');
  assert.ok(e.at > 0);
});

test('起跑：程序化发送（自动开发/复盘总结等不带 userTyped）一条都不记', async () => {
  resetLog();
  await start({ prompt: '请按开发文档实现以下需求……', cwd: DATA_DIR, convId: 'c1' });
  await start({ prompt: '请对本次开发做复盘总结', cwd: DATA_DIR, convId: 'c1', userTyped: 'true' }); // 字符串不算标记
  await start({ prompt: '继续', cwd: DATA_DIR, convId: 'c1', userTyped: 1 });
  assert.deepEqual(logged(), []);
});

test('起跑：种子前置时只记用户原文，不记被拼进去的系统正文', async () => {
  resetLog();
  await start({
    prompt: '【需求上下文】……一大段系统种子……\n\n先看下登录模块',
    typedText: '先看下登录模块',
    cwd: DATA_DIR,
    convId: 'c1',
    userTyped: true,
  });
  assert.equal(logged()[0].text, '先看下登录模块');
});

test('插话：带 userTyped 记成 kind=steer，上下文取自 run', async (t) => {
  resetLog();
  const run = createRun();
  t.after(() => finishRun(run));
  run.capabilities.steer = true;
  run.convId = 'c9';
  run.session_id = 'sess-9';
  run.cwd = 'C:\\proj';
  run.model = 'sonnet';

  const r = await post('/send', { runId: run.id, text: '停，别动那个文件', userTyped: true });
  assert.equal(r.json.ok, true);
  const [e] = logged();
  assert.equal(e.kind, 'steer', 'steer 是「AI 跑偏被打断」的高价值信号，必须与 send 区分');
  assert.equal(e.text, '停，别动那个文件');
  assert.equal(e.convId, 'c9');
  assert.equal(e.sessionId, 'sess-9');
  assert.equal(e.cwd, 'C:\\proj');
  assert.equal(e.model, 'sonnet');
});

test('插话：程序化插话（无 userTyped）不记', async (t) => {
  resetLog();
  const run = createRun();
  t.after(() => finishRun(run));
  run.capabilities.steer = true;
  const r = await post('/send', { runId: run.id, text: '设计准则已更新，请在后续开发中遵循：……' });
  assert.equal(r.json.ok, true);
  assert.deepEqual(logged(), []);
});

test('插话未被持有（run 已结束）时不记 —— 前端会降级成新一轮，由起跑那边记，避免重复', async () => {
  resetLog();
  const run = createRun();
  run.capabilities.steer = true;
  finishRun(run);
  const r = await post('/send', { runId: run.id, text: '这句会走降级路径', userTyped: true });
  assert.equal(r.json.ok, false);
  assert.deepEqual(logged(), []);
});

test('空文本仍按原有 400 处理，且不落日志', async () => {
  resetLog();
  const run = createRun();
  run.capabilities.steer = true;
  const r = await post('/send', { runId: run.id, text: '   ', userTyped: true });
  finishRun(run);
  assert.equal(r.status, 400);
  assert.deepEqual(logged(), []);
});

/**
 * attach 撞上不存在的 run 时，必须如实告诉前端「还有没有人会送新 run 上来」。
 * 前端的「run 不存在 → 静默等待」分支等的就是这个新 run；没有计划却让它等，
 * 气泡就永久停在「运行中…」（2026-08-28 事故的后半段）。
 */
test('GET /api/run 撞上不存在的 run：按 pending 条目回 resumePlanned', async () => {
  // SSE 端点会持续挂住连接，只读首个事件块即可断开
  const readFirstEvent = async (query) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/run?${query}`, { signal: ac.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    ac.abort();
    return new TextDecoder().decode(value);
  };

  // 无 pending 条目 → false
  let chunk = await readFirstEvent('runId=run_ghost&convId=c_no_plan');
  assert.match(chunk, /run 不存在或已过期/);
  assert.match(chunk, /"resumePlanned":false/, '无续跑条目必须明确回 false，前端据此中性终结');

  // 有活条目 → true
  addPending({ convId: 'c_has_plan', session_id: 's1', resetsAt: Math.floor(Date.now() / 1000) });
  chunk = await readFirstEvent('runId=run_ghost&convId=c_has_plan');
  assert.match(chunk, /"resumePlanned":true/, '有 waiting 条目应让前端继续静默等待');

  // 不传 convId → null（未知），前端按现状静默等待，老前端不回归
  chunk = await readFirstEvent('runId=run_ghost');
  assert.match(chunk, /"resumePlanned":null/, '拿不到判据时不能谎报 false');
});

/**
 * 提交幂等（P1，见 store/submissions.js）：同一 requestId 的重复提交至多一次副作用。
 * 起跑走 openai-compat 无凭证路径（立刻 failRun），不会真发模型调用。
 */
test('起跑：同 requestId 第二次提交回放既有 runId，不重复创建', async () => {
  const requestId = 'rq_idem_start_' + Date.now();
  const r1 = await start({ prompt: '幂等：只应起一个', cwd: DATA_DIR, convId: 'c_idem', requestId });
  assert.equal(r1.status, 200);
  assert.ok(r1.json.runId);
  assert.ok(!r1.json.duplicate);

  const r2 = await start({ prompt: '幂等：只应起一个', cwd: DATA_DIR, convId: 'c_idem', requestId });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.runId, r1.json.runId, '重复提交必须回放同一个 run');
  assert.equal(r2.json.duplicate, true);
});

test('起跑：不带 requestId 时行为与现状一致（每次都是新 run）', async () => {
  const r1 = await start({ prompt: '无幂等键', cwd: DATA_DIR, convId: 'c_noid' });
  const r2 = await start({ prompt: '无幂等键', cwd: DATA_DIR, convId: 'c_noid' });
  assert.ok(r1.json.runId && r2.json.runId);
  assert.notEqual(r1.json.runId, r2.json.runId);
});

test('插话：同 requestId 第二次提交回放同一 msgId，不重复持有', async (t) => {
  const run = createRun();
  t.after(() => finishRun(run));
  run.capabilities.steer = true;
  run.convId = 'c_idem_steer';
  const requestId = 'rq_idem_steer_' + Date.now();

  const r1 = await post('/send', { runId: run.id, text: '同一句插话', requestId });
  assert.equal(r1.json.ok, true);
  assert.ok(r1.json.msgId);

  const r2 = await post('/send', { runId: run.id, text: '同一句插话', requestId });
  assert.equal(r2.json.ok, true);
  assert.equal(r2.json.msgId, r1.json.msgId);
  assert.equal(r2.json.duplicate, true);
  assert.equal(run.heldMsgs.length, 1, '重复提交不得重复持有');
});

test('插话：run 已结束时的重复提交仍回 ok:false（前端走降级新一轮，不回放废插话）', async () => {
  const run = createRun();
  run.capabilities.steer = true;
  const requestId = 'rq_idem_dead_' + Date.now();
  const r1 = await post('/send', { runId: run.id, text: '这句先被持有', requestId });
  assert.equal(r1.json.ok, true);
  finishRun(run);

  const r2 = await post('/send', { runId: run.id, text: '这句先被持有', requestId });
  assert.equal(r2.json.ok, false, 'run 已终结：降级路径优先于幂等回放');
});

// ==== P4 busy inbox：路由 / 幂等 / 撤回 / 立即生效话术 / 排空发现 ====

test('busy inbox 路由：followUp 能力 run 的 /send 进队列（ok:true + mode:follow_up），不再降级并发', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_fu_route';
  run.capabilities.followUp = true; // openai 能力模型：不可 steer、可排队

  const r = await post('/send', { runId: run.id, text: '等它跑完再处理这句' });
  assert.equal(r.json.ok, true, '必须 ok:true——ok:false 会把前端赶去降级路径并发起第二个 run');
  assert.equal(r.json.mode, 'follow_up');
  const items = listFollowUps('c_fu_route');
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '等它跑完再处理这句');
  assert.equal(run.heldMsgs.length, 0, 'follow-up 不进持有区');
});

test('busy inbox 路由：同 requestId 重复 /send 回放同一排队项，不重复排队', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_fu_idem';
  run.capabilities.followUp = true;
  const requestId = 'rq_fu_idem_' + Date.now();

  const r1 = await post('/send', { runId: run.id, text: '排队幂等', requestId });
  assert.equal(r1.json.ok, true);
  assert.equal(r1.json.mode, 'follow_up');
  const r2 = await post('/send', { runId: run.id, text: '排队幂等', requestId });
  assert.equal(r2.json.ok, true);
  assert.equal(r2.json.msgId, r1.json.msgId);
  assert.equal(r2.json.mode, 'follow_up');
  assert.equal(r2.json.duplicate, true);
  assert.equal(listFollowUps('c_fu_idem').length, 1, '重复提交不得重复排队');
});

test('busy inbox 路由：queue-first —— followUp 优先于 steer，两个能力都在也默认排队', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_both_caps';
  run.capabilities.steer = true;
  run.capabilities.followUp = true;

  const r = await post('/send', { runId: run.id, text: '默认排队，不进当前 run' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'follow_up', 'queue-first：两能力兼备时默认排队（「立即发送」才是显式 steer）');
  assert.equal(run.heldMsgs.length, 0);
  assert.equal(listFollowUps('c_both_caps').length, 1);
});

test('busy inbox 路由：无排队能力的老 provider 才退回持有区（steer-only）', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_steer_only';
  run.capabilities.steer = true;

  const r = await post('/send', { runId: run.id, text: '老 provider 退回持有区' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'steer');
  assert.equal(run.heldMsgs.length, 1);
  assert.equal(listFollowUps('c_steer_only').length, 0);
});

test('撤回：follow-up 可撤回（conv 级队列），已排空后返回 ok:false', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_fu_withdraw';
  run.capabilities.followUp = true;

  const r = await post('/send', { runId: run.id, text: '撤回我' });
  const w = await post('/msg/withdraw', { runId: run.id, msgId: r.json.msgId });
  assert.equal(w.json.ok, true);
  assert.equal(listFollowUps('c_fu_withdraw').length, 0);

  // 撤回后（队列已空/已排空）再撤同一 msgId → false，前端提示「已进入任务」
  const w2 = await post('/msg/withdraw', { runId: run.id, msgId: r.json.msgId });
  assert.equal(w2.json.ok, false);
});

test('立即生效：follow-up 无法中途插入 → ok:false + mode:follow_up（前端给准话术）', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_fu_now';
  run.capabilities.followUp = true;
  await post('/send', { runId: run.id, text: '排着' });

  const r = await post('/msg/now', { runId: run.id });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.mode, 'follow_up');
});

// ==== P1-10 步边界 steer（openai）→ 2026-10-16 queue-first 后的显式「立即发送」====

test('P1-10（legacy 兜底）：steerMode=step 且无排队能力 → /send 进持有区，mode:steer', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_step_steer';
  run.capabilities.steer = true;
  run.capabilities.steerMode = 'step';

  const r = await post('/send', { runId: run.id, text: '别按原方案走' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'steer');
  assert.ok(String(r.json.msgId).startsWith('hm_'), '持有区 id 前缀 hm_');
  assert.equal(run.heldMsgs.length, 1);
  assert.equal(listFollowUps('c_step_steer').length, 0, 'step 模式不产生排队项');
});

test('queue-first：step 模式（openai 常态，steer+followUp）的 /send 也默认排队', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_step_queue';
  run.capabilities.steer = true;
  run.capabilities.steerMode = 'step';
  run.capabilities.followUp = true;

  const r = await post('/send', { runId: run.id, text: '排队等下一轮' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'follow_up');
  assert.ok(String(r.json.msgId).startsWith('fu_'), '排队项 id 前缀 fu_');
  assert.equal(run.heldMsgs.length, 0);
  assert.equal(listFollowUps('c_step_queue').length, 1);
});

test('P1-10：steerMode=step 的 /msg/now → ok:true（到达即已请求抢占，无 SDK 流可打断）', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_step_now';
  run.capabilities.steer = true;
  run.capabilities.steerMode = 'step';
  await post('/send', { runId: run.id, text: '尽快看到这句' });
  assert.equal(run.heldMsgs.length, 1);

  const r = await post('/msg/now', { runId: run.id });
  assert.equal(r.json.ok, true, '步边界模式没有可打断的输入流：抢占在消息到达时已请求，回执成功');
  assert.equal(run.heldMsgs.length, 1, '回执不消费消息——由 agent-loop 步边界取走');
});

test('P1-10：无 _input 的非 step steer（Claude 判档窗口）行为不变 → ok:false', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_judge_window';
  run.capabilities.steer = true; // Claude：steer=true，_input 未就绪（判档窗口）
  await post('/send', { runId: run.id, text: '判档窗口的话' });

  const r = await post('/msg/now', { runId: run.id });
  assert.equal(r.json.ok, false, '缺 _input 且非 step：维持 ok:false（消息首轮 result 自动进入）');
});

test('/api/run/pending：附最近排空启动记录（含 texts），供前端发现并接上新 run 的流', async () => {
  clearFollowUps();
  markFollowUpStarted('c_poll', { runId: 'run_drained_1', ids: ['fu_a', 'fu_b'], texts: ['甲', '乙'] });
  const r = await post('/pending', {});
  const hit = (r.json.followUps || []).find((f) => f.runId === 'run_drained_1');
  assert.ok(hit, '排空记录必须出现在 /pending 响应里（否则前端无从接流）');
  assert.deepEqual(hit.ids, ['fu_a', 'fu_b']);
  assert.deepEqual(hit.texts, ['甲', '乙'], '排空记录须带原文（客户端离线期间被排空的消息靠它上屏）');
  assert.equal(hit.convId, 'c_poll');
});

// ==== queue-first：立即发送（steer-now）/ 队列清单 ====

/** 造一个带可用输入流的 turn 模式 run（Claude）：记录 push/interrupt 供断言 */
function turnRunWithInput(convId, { pushResult = true } = {}) {
  const run = createRun();
  run.convId = convId;
  run.capabilities.steer = true;
  run.capabilities.steerMode = 'turn';
  run.capabilities.followUp = true;
  const pushed = [];
  let interrupts = 0;
  run._input = {
    push: (t) => {
      pushed.push(t);
      return pushResult;
    },
    interrupt: () => {
      interrupts++;
      return Promise.resolve();
    },
  };
  return { run, pushed, interrupts: () => interrupts };
}

test('立即发送（turn）：排队项转持有区并 flush + interrupt，id 不变、队列清空', async (t) => {
  clearFollowUps();
  const { run, pushed, interrupts } = turnRunWithInput('c_now_turn');
  t.after(() => finishRun(run));
  const r0 = await post('/send', { runId: run.id, text: '插进当前任务' });
  assert.equal(r0.json.mode, 'follow_up');
  assert.equal(listFollowUps('c_now_turn').length, 1);

  const r = await post('/msg/now', { runId: run.id, msgId: r0.json.msgId });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'steer');
  assert.equal(listFollowUps('c_now_turn').length, 0, '转换后不再留在队列');
  assert.deepEqual(pushed, ['插进当前任务'], 'turn 模式必须 flush 进 SDK 输入流');
  assert.equal(run.heldMsgs.length, 0, 'flush 成功即离开持有区');
  assert.equal(interrupts(), 1, '打断当前轮以便尽快读入');
});

test('立即发送（turn）：输入流未就绪（判档窗口）→ ok:false not_ready，队列不动', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_now_ready';
  run.capabilities.steer = true;
  run.capabilities.followUp = true; // 无 _input：判档窗口
  const r0 = await post('/send', { runId: run.id, text: '先别动' });

  const r = await post('/msg/now', { runId: run.id, msgId: r0.json.msgId });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'not_ready');
  assert.equal(listFollowUps('c_now_ready').length, 1, '拒绝时不得动队列');
  assert.equal(run.heldMsgs.length, 0);
});

test('立即发送（turn）：输入流已关闭 → 同步回滚回队（原位置、id 不变），消息不丢', async (t) => {
  clearFollowUps();
  const { run, pushed } = turnRunWithInput('c_now_rollback', { pushResult: false });
  t.after(() => finishRun(run));
  const rA = await post('/send', { runId: run.id, text: '甲' });
  const rB = await post('/send', { runId: run.id, text: '乙' });
  const rC = await post('/send', { runId: run.id, text: '丙' });
  assert.deepEqual(listFollowUps('c_now_rollback').map((m) => m.text), ['甲', '乙', '丙']);

  const r = await post('/msg/now', { runId: run.id, msgId: rB.json.msgId });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'input_closed');
  assert.equal(run.heldMsgs.length, 0, '回滚后不留持有区残影');
  assert.deepEqual(listFollowUps('c_now_rollback').map((m) => m.text), ['甲', '乙', '丙'], '回滚必须回到原位置');
  assert.deepEqual(listFollowUps('c_now_rollback').map((m) => m.id), [rA.json.msgId, rB.json.msgId, rC.json.msgId]);
  assert.deepEqual(pushed, ['乙'], 'push 已尝试过一次（返回 false）——但消息仍回到队列');
});

test('立即发送（step）：排队项转持有区、回执 ok，由 agent-loop 步边界取走', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_now_step';
  run.capabilities.steer = true;
  run.capabilities.steerMode = 'step';
  run.capabilities.followUp = true;
  const r0 = await post('/send', { runId: run.id, text: '尽快看到这句' });

  const r = await post('/msg/now', { runId: run.id, msgId: r0.json.msgId });
  assert.equal(r.json.ok, true);
  assert.equal(listFollowUps('c_now_step').length, 0);
  assert.equal(run.heldMsgs.length, 1, 'step 模式留在持有区等步边界/抢占消费');
  assert.equal(run.heldMsgs[0].id, r0.json.msgId, 'id 复用：consumed 对账全链路对得上');
  assert.equal(run.heldMsgs[0].origin, 'queue');
});

test('立即发送：msgId 已不在队列（已消费/已撤回）→ ok:false gone，不凭空造消息', async (t) => {
  clearFollowUps();
  const { run } = turnRunWithInput('c_now_gone');
  t.after(() => finishRun(run));
  const r = await post('/msg/now', { runId: run.id, msgId: 'fu_not_exist' });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'gone');
  assert.equal(run.heldMsgs.length, 0);
});

test('GET /api/run/queue：返回该 conv 的持有区（steer）+ 排队项（queue）与当前 runId', async (t) => {
  clearFollowUps();
  const { run } = turnRunWithInput('c_queue_list');
  t.after(() => finishRun(run));
  await post('/send', { runId: run.id, text: '排队的甲' });
  await post('/send', { runId: run.id, text: '排队的乙' });
  run.heldMsgs.push({ id: 'hm_manual', text: '已点立即发送的丙' }); // 模拟已转换的持有项

  const res = await fetch(base + '/api/run/queue?convId=c_queue_list');
  const d = await res.json();
  assert.equal(d.runId, run.id);
  assert.deepEqual(
    d.items.map((x) => [x.mode, x.text]),
    [
      ['steer', '已点立即发送的丙'],
      ['queue', '排队的甲'],
      ['queue', '排队的乙'],
    ],
  );
  assert.ok(d.items.every((x) => typeof x.id === 'string' && x.id.length));

  const empty = await (await fetch(base + '/api/run/queue?convId=c_none')).json();
  assert.deepEqual(empty, { runId: null, items: [] });
});

test('/api/run/start 撞上运行中会话：按能力路由进 inbox，不新起 run', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_busy_guard';
  run.capabilities.followUp = true;
  run.cwd = DATA_DIR;

  const requestId = 'rq_busy_' + Date.now();
  const r1 = await post('/start', {
    provider: 'openai-compat',
    model: 'gpt-x',
    prompt: '运行中追加的消息',
    cwd: DATA_DIR,
    convId: 'c_busy_guard',
    requestId,
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.queued, true);
  assert.equal(r1.json.runId, run.id, '必须指向已有 run，不得新起');
  assert.equal(r1.json.mode, 'follow_up');
  assert.equal(listFollowUps('c_busy_guard').length, 1);

  // 幂等：同一 requestId 重试回放原排队项（runId 仍指向该 run），不重复入队
  const r2 = await post('/start', {
    provider: 'openai-compat',
    model: 'gpt-x',
    prompt: '运行中追加的消息',
    cwd: DATA_DIR,
    convId: 'c_busy_guard',
    requestId,
  });
  assert.equal(r2.json.queued, true);
  assert.equal(r2.json.duplicate, true);
  assert.equal(r2.json.msgId, r1.json.msgId);
  assert.equal(listFollowUps('c_busy_guard').length, 1);
});

test('/api/run/start 撞上 Claude 能力 run（steer+followUp）：queue-first 默认排队，不插话', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_busy_claude';
  run.capabilities.steer = true;
  run.capabilities.followUp = true;

  const r = await post('/start', { prompt: '排队等当前任务跑完', convId: 'c_busy_claude' });
  assert.equal(r.json.queued, true);
  assert.equal(r.json.mode, 'follow_up');
  assert.equal(r.json.runId, run.id);
  assert.equal(run.heldMsgs.length, 0, '默认不再插进当前 run');
  assert.equal(listFollowUps('c_busy_claude').length, 1);
});

test('/api/run/start 撞上 steer-only 老 provider：退回持有区（legacy 兜底）', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_busy_steer';
  run.capabilities.steer = true;

  const r = await post('/start', { prompt: '插进当前 run', convId: 'c_busy_steer' });
  assert.equal(r.json.queued, true);
  assert.equal(r.json.mode, 'steer');
  assert.equal(r.json.runId, run.id);
  assert.equal(run.heldMsgs.length, 1);
});

test('/api/run/start 撞上运行中会话：同 requestId 已受理过 → 回放既有 run，不二次入队', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_busy_replay';
  run.capabilities.followUp = true;

  // 模拟「先前那次 /start 已创建 run 并 bind」：重试到达时命中 start: 认领 → 纯回放
  const requestId = 'rq_busy_replay_' + Date.now();
  claimSubmission('start:' + requestId, {});
  bindSubmission('start:' + requestId, 'run_earlier');

  const r = await post('/start', {
    provider: 'openai-compat',
    model: 'gpt-x',
    prompt: '网络重试的同一条',
    convId: 'c_busy_replay',
    requestId,
  });
  assert.equal(r.json.duplicate, true);
  assert.equal(r.json.runId, 'run_earlier');
  assert.equal(listFollowUps('c_busy_replay').length, 0, '已受理过的重试不得二次入队');
});

test('/api/run/start 撞上两能力皆无的 run：明确拒绝，不入队不并发', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_busy_none';

  const r = await post('/start', { prompt: '无处安放', convId: 'c_busy_none' });
  assert.equal(r.status, 200);
  assert.equal(r.json.queued, false);
  assert.match(r.json.error, /不支持中途追加/);
  assert.equal(listFollowUps('c_busy_none').length, 0);
  assert.equal(run.heldMsgs.length, 0);
});

// ==== T6：openai 路径工具策略档位透传 ====

test('起跑 openai：mode 归一后落到 run.mode（T6 策略档位）；非法值 fail-closed 到 default', async () => {
  const r = await post('/start', {
    provider: 'openai-compat',
    model: 'gpt-x',
    prompt: '档位透传',
    cwd: DATA_DIR,
    convId: 'c_mode',
    mode: 'acceptEdits',
  });
  const run = getRun(r.json.runId);
  assert.equal(run.mode, 'acceptEdits', 'openai 路径必须拿到归一后的档位（规则表按它裁决）');
  finishRun(run);

  const r2 = await post('/start', {
    provider: 'openai-compat',
    model: 'gpt-x',
    prompt: '档位透传',
    cwd: DATA_DIR,
    convId: 'c_mode2',
    mode: 'hacker',
  });
  const run2 = getRun(r2.json.runId);
  assert.equal(run2.mode, 'default', '非法档位 fail-closed');
  finishRun(run2);
});

test('SSE replay：held 含 conv inbox 的 follow-up（重连不清排队态、保留撤回按钮）', async (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = 'c_replay_fu';
  run.capabilities.followUp = true;
  const r = await post('/send', { runId: run.id, text: '重连前排队' });
  assert.equal(r.json.ok, true);

  const ac = new AbortController();
  const res = await fetch(`${base}/api/run?runId=${encodeURIComponent(run.id)}&convId=c_replay_fu`, { signal: ac.signal });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  ac.abort();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /event: replay/);
  assert.ok(chunk.includes(r.json.msgId), 'held 列表必须包含排队中的 follow-up id');
});

