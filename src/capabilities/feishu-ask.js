/**
 * 「委托同事对话」—— 主 agent 派活，子引擎把话题聊出结论再交回。
 *
 * 不是「收到下一条消息就唤醒」：同事的回复先过一遍判定引擎（LLM 单轮）——
 * 没得出结论就自动追问（上限 MAX_FOLLOW_UPS 轮），得出完整结论才结算。
 * 主 agent 用 WaitColleagueReply 拿到的是**结论**，而不是某一条原始回复。
 *
 * 链路：
 *   AskColleague（发飞书卡片提问，非阻塞，返回 questionId）
 *   → 同事回复 → feishu 进程 relay → web 的 /api/req/colleague-agent/turn
 *   → 本模块截住（handleColleagueAskReply）→ 判定引擎：追问 or 结算
 *   → 主 agent WaitColleagueReply 拿结论继续任务
 *
 * 为什么注册表在内存：委托绑定在某个 run 的生命周期上（run 本身是内存态，进程重启即消失），
 * 落盘只会制造「重启后无人认领的追问」，让子引擎继续打扰同事。
 *
 * 护栏：
 * - 同一同事同时只允许一个进行中的委托（一条回复无法同时回答两个问题）
 * - 追问上限 + 30 分钟 TTL，超了如实交回已有信息（未得出/未回复都明确说）
 * - 主 agent 等待超时 / 运行被停止 = 取消整个委托（不再自动追问），迟到回复回落同事对话 agent
 */
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getColleagues } from '../store/colleagues.js';
import { appendTo } from '../store/colleague-messages.js';
import { getActiveBot } from '../store/settings.js';
// 非阻塞提示卡：把「问同事」卡片同步推到 web 执行台（同卡双向联动）。
// capabilities → store 合规；runs.js 只 import shared/logger，无环。
import { getRun, presentNotice, dismissNotice } from '../store/runs.js';
import { sendCardToUser, sendTextToUser } from '../integrations/lark.js';
import { runClassifierOnce } from './llm-classify.js';
import { MAX_FOLLOW_UPS, buildAskCard, buildJudgePrompt, parseJudgeResult, resolveColleagueTarget } from './feishu-ask.logic.js';

const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 30 * 60 * 1000;
/** 委托总生命周期：超过就没收，避免没人消费的委托永远挂着 */
const ASK_TTL_MS = 30 * 60 * 1000;
/** 判定引擎单轮预算：写的是给真人看的话，比纯分类多给一点时间 */
const JUDGE_TIMEOUT_MS = 45_000;
/** 已结算但主 agent 还没来取的委托，保留这么久后清理 */
const SETTLED_KEEP_MS = 15 * 60 * 1000;
/** 转录上限（条）：保首条问题 + 最近 N 条，防止长对话无限增长 */
const MAX_TRANSCRIPT = 40;

/** questionId -> task；colleagueId -> questionId（只登记进行中的委托） */
const tasks = new Map();
const byColleague = new Map();

/** 测试复位：清空注册表并取消所有定时器 */
export function clearAsks() {
  for (const t of tasks.values()) {
    clearTimeout(t.expiryTimer);
    clearTimeout(t.cleanupTimer);
  }
  tasks.clear();
  byColleague.clear();
}

/** 选项归一：去空去重、最多 4 个；<2 个时补兜底选项（保证卡片有按钮，web 双向联动才成立） */
function normalizeOptions(raw) {
  const uniq = [...new Set((Array.isArray(raw) ? raw : []).map((o) => String(o ?? '').trim()).filter(Boolean))].slice(0, 4);
  if (uniq.length >= 2) return uniq;
  if (uniq.length === 1) return [uniq[0], '其他（我打字补充）'];
  return ['知道了，按你说的来', '不清楚 / 需要再确认', '稍后再说'];
}

/**
 * 把委托卡推到 web 执行台（同 run 的 notice 卡）。run 不在了（runId 空、run 已终结、
 * 进程重启后注册表已失）就静默跳过——提示卡是增强，绝不是主链路的必要条件。
 */
function presentTaskNotice(task) {
  if (!task.runId) return;
  try {
    const run = getRun(task.runId);
    if (!run) return;
    presentNotice(run, {
      id: task.questionId,
      kind: 'feishu-ask',
      title: `问同事：${task.colleagueName}`,
      body: task.context ? `${task.question}\n\n—\n${task.context}` : task.question,
      options: task.options,
    });
  } catch (e) {
    logger.warn('feishu-ask', '推送 web 提示卡失败（已忽略）', { questionId: task.questionId, err: e?.message || String(e) });
  }
}

/** 收起 web 提示卡（结算/失效/取消时调用）；同样尽力而为 */
function dismissTaskNotice(task) {
  if (!task.runId) return;
  try {
    const run = getRun(task.runId);
    if (run) dismissNotice(run, task.questionId);
  } catch (e) {
    logger.warn('feishu-ask', '收起 web 提示卡失败（已忽略）', { questionId: task.questionId, err: e?.message || String(e) });
  }
}

function activeBotCreds() {
  const bot = getActiveBot();
  return bot?.appId && bot?.appSecret ? { appId: bot.appId, appSecret: bot.appSecret } : null;
}

function genQuestionId() {
  return 'fq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 判定引擎：单轮无工具 JSON 调用（复用 llm-classify 的额度/超时/解析防护） */
async function defaultJudge(input) {
  return runClassifierOnce({
    prompt: buildJudgePrompt(input),
    model: config.feishuAsk.model,
    task: 'feishuAsk',
    logTag: 'feishu-ask/judge',
    timeoutMs: JUDGE_TIMEOUT_MS,
  });
}

function safeAppend(appendMessage, colleague, text) {
  try {
    appendMessage(colleague.id, { dir: 'out', text, role: colleague.role, reqId: null });
  } catch (e) {
    // 留痕失败不能影响主链路（消息已经发出去了）
    logger.warn('feishu-ask', '留痕写入失败（已忽略）', { colleagueId: colleague.id, err: e?.message || String(e) });
  }
}

function waitingTaskFor(colleagueId) {
  const qid = byColleague.get(colleagueId);
  const task = qid ? tasks.get(qid) : null;
  return task && task.status === 'waiting' ? task : null;
}

function drop(questionId) {
  const task = tasks.get(questionId);
  if (!task) return;
  clearTimeout(task.expiryTimer);
  clearTimeout(task.cleanupTimer);
  tasks.delete(questionId);
  if (byColleague.get(task.colleagueId) === questionId) byColleague.delete(task.colleagueId);
}

/** 结算：唤醒等待者（若有），否则留待主 agent 稍后来取；到期由 cleanupTimer 清理 */
function settle(task, status, { conclusion = '', reason = '' } = {}) {
  if (task.status !== 'waiting') return;
  clearTimeout(task.expiryTimer);
  dismissTaskNotice(task); // 委托了结（含取消/过期）→ web 端同一张卡一并收起
  task.status = status;
  task.outcome = { status, conclusion, reason, transcript: task.transcript.slice() };
  if (byColleague.get(task.colleagueId) === task.questionId) byColleague.delete(task.colleagueId);
  const waiter = task.waiter;
  if (waiter) {
    task.waiter = null;
    drop(task.questionId);
    waiter(task.outcome);
  } else {
    task.cleanupTimer = setTimeout(() => drop(task.questionId), SETTLED_KEEP_MS);
    task.cleanupTimer.unref?.();
  }
}

function buildResult(task, outcome) {
  return {
    status: outcome.status,
    conclusion: outcome.conclusion,
    reason: outcome.reason,
    colleagueName: task.colleagueName,
    followUps: task.followUps,
    transcript: outcome.transcript || task.transcript.slice(),
  };
}

function consume(task) {
  const result = buildResult(task, task.outcome);
  drop(task.questionId);
  return result;
}

function expireTask(task) {
  if (task.status !== 'waiting') {
    drop(task.questionId);
    return;
  }
  settle(task, 'expired', { reason: '对方长时间未回复，提问已过期' });
  if (!task.waiter) drop(task.questionId); // 没人等就直接没收；settle 给没人等的分支挂的清理定时器一并清掉
}

/**
 * 发起委托提问（非阻塞）。
 * @returns {Promise<{ok:true, questionId:string, colleague:object, expiresAt:number}|{error:string}>}
 */
export async function askColleague(input = {}, deps = {}) {
  const {
    getColleagues: listColleagues = getColleagues,
    sendCard = (creds, openId, card) => sendCardToUser(creds, openId, card),
    appendMessage = appendTo,
    getBotCreds = activeBotCreds,
  } = deps;

  const question = String(input.question || '').trim();
  if (!question) return { error: 'question 不能为空' };
  const context = String(input.context || '').trim();
  const options = normalizeOptions(input.options);

  const { colleague, error } = resolveColleagueTarget(listColleagues(), { role: input.role, name: input.name });
  if (error) return { error };

  const ongoing = waitingTaskFor(colleague.id);
  if (ongoing) {
    return { error: `${colleague.name} 已有一条进行中的提问（${ongoing.questionId}），等它结束或换一位同事` };
  }

  const creds = getBotCreds();
  if (!creds) return { error: '未启用飞书机器人或凭证不全，无法发起询问（请在设置页配置）' };

  // questionId 必须先于建卡生成：选项按钮的 value 要带它，回调才能定位到这条委托
  const questionId = genQuestionId();
  let messageId = null;
  try {
    messageId = await sendCard(creds, colleague.feishuOpenId, buildAskCard({ question, context, options, questionId }));
  } catch (e) {
    logger.warn('feishu-ask', '询问卡片发送异常', { colleagueId: colleague.id, err: e?.message || String(e) });
  }
  if (!messageId) return { error: '飞书卡片发送失败（检查机器人权限与 open_id）' };

  const now = Date.now();
  const task = {
    questionId,
    colleagueId: colleague.id,
    colleagueName: colleague.name,
    colleagueRole: colleague.role,
    openId: colleague.feishuOpenId,
    question,
    context,
    options,
    messageId, // 飞书卡片 message_id（去重/将来就地改卡用）
    runId: input.runId || null,
    convId: input.convId || null,
    transcript: [],
    status: 'waiting',
    outcome: null,
    followUps: 0,
    maxFollowUps: MAX_FOLLOW_UPS,
    processing: false,
    reprocess: false,
    waiter: null,
    askedAt: now,
    expiresAt: now + ASK_TTL_MS,
    expiryTimer: null,
    cleanupTimer: null,
  };
  task.expiryTimer = setTimeout(() => expireTask(task), ASK_TTL_MS);
  task.expiryTimer.unref?.();
  tasks.set(task.questionId, task);
  byColleague.set(colleague.id, task.questionId);
  task.transcript.push({ dir: 'out', text: question, at: new Date(now).toISOString() });
  safeAppend(appendMessage, colleague, `【提问】${question}`);
  presentTaskNotice(task); // web 执行台同卡（问题+选项）；run 不在时静默跳过

  logger.info('feishu-ask', '已发起委托提问', { questionId: task.questionId, colleagueId: colleague.id, runId: task.runId });
  return { ok: true, questionId: task.questionId, colleague: { id: colleague.id, name: colleague.name, role: colleague.role }, expiresAt: task.expiresAt };
}

/** 入站回复公共段：记入转录（带上限截断）并起串行判定步进。文字/附件/点选三条路径共用一处。 */
function feedReply(task, { text = '', files = [], deps = {} }) {
  if (task.transcript.length >= MAX_TRANSCRIPT) task.transcript.splice(1, task.transcript.length - (MAX_TRANSCRIPT - 1));
  task.transcript.push({ dir: 'in', text, files, at: new Date().toISOString() });
  return { questionId: task.questionId, step: scheduleStep(task, deps) };
}

/**
 * 同事回复进入本模块（由 web 路由在同事对话 agent 之前调用）。
 * @returns {null | {questionId:string, step:Promise<void>}} null = 没有进行中的委托（回落同事对话 agent）
 */
export function handleColleagueAskReply(colleagueId, msg = {}, deps = {}) {
  const task = waitingTaskFor(colleagueId);
  if (!task) return null;
  const text = String(msg.text || '').trim();
  const files = (Array.isArray(msg.files) ? msg.files : [])
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({ name: String(f.name || ''), path: String(f.path || ''), kind: f.kind === 'image' ? 'image' : 'file' }));
  if (!text && !files.length) return null;
  return feedReply(task, { text, files, deps });
}

/**
 * 同事在飞书卡上**点选选项** → 当作一次回答喂进判定引擎（与文字回复同一闭环，仍会自动追问/结算）。
 * 按 questionId 直查（卡片 value 自带，不依赖 open_id 反查）。
 * @returns {null | {questionId:string, step:Promise<void>}} null = 委托不存在/已结算（迟到的点击）
 */
export function handleColleagueAskOption(questionId, option, deps = {}) {
  const task = tasks.get(String(questionId || ''));
  if (!task || task.status !== 'waiting') return null;
  const opt = String(option ?? '').trim();
  if (!opt) return null;
  return feedReply(task, { text: `（点选）${opt}`, deps });
}

/**
 * 主机在 web 执行台点了选项 → 立即结算这条委托（结论＝「开发者已确认：X」）并通知同事。
 *
 * 与同事点选的区别（刻意不同）：同事点选只是「一次回答」，仍走判定引擎确认细节；
 * 主机点选是**拍板**，直接终结委托——避免主机已经确认了、子引擎还在追问同事。
 *
 * @returns {Promise<{ok:true, conclusion:string}|{ok:false, error:string}>}
 */
export async function confirmAskFromHost(questionId, option, deps = {}) {
  const {
    getBotCreds = activeBotCreds,
    sendText = (creds, openId, text) => sendTextToUser(creds, openId, text),
    appendMessage = appendTo,
  } = deps;
  const task = tasks.get(String(questionId || ''));
  if (!task || task.status !== 'waiting') return { ok: false, error: '该提问已结束或不存在' };
  const opt = String(option ?? '').trim();
  if (!opt) return { ok: false, error: '缺少选项' };
  if (task.options.length && !task.options.includes(opt)) return { ok: false, error: `所选答案不在选项中：${opt}` };

  const conclusion = `开发者已确认：${opt}`;
  // 先把「主机拍板」记进转录，再 settle —— 保证主 agent 拿到的结论里带上这条事实
  task.transcript.push({ dir: 'in', text: conclusion, at: new Date().toISOString(), byHost: true });
  settle(task, 'concluded', { conclusion });
  safeAppend(appendMessage, { id: task.colleagueId, role: task.colleagueRole }, `【开发者确认】${opt}`);

  // 通知同事（尽力而为：结算已完成，通知失败只留痕，不回滚）
  const creds = getBotCreds();
  if (!creds) {
    logger.warn('feishu-ask', '开发者确认无法通知同事：机器人凭证缺失', { questionId: task.questionId });
  } else {
    try {
      await sendText(creds, task.openId, conclusion);
    } catch (e) {
      logger.warn('feishu-ask', '开发者确认通知发送异常（已忽略）', { questionId: task.questionId, err: e?.message || String(e) });
    }
  }
  logger.info('feishu-ask', '开发者已在执行台确认（委托结算）', { questionId: task.questionId, colleagueId: task.colleagueId });
  return { ok: true, conclusion };
}

/** 串行步进：一步处理期间又来消息就标记 reprocess，本步结束后接着跑，绝不并发判定 */
function scheduleStep(task, deps) {
  if (task.processing) {
    task.reprocess = true;
    return Promise.resolve();
  }
  task.processing = true;
  const run = (async () => {
    try {
      do {
        task.reprocess = false;
        await runStep(task, deps);
      } while (task.reprocess && task.status === 'waiting');
    } catch (e) {
      logger.warn('feishu-ask', '委托步进异常（保持等待）', { questionId: task.questionId, err: e?.message || String(e) });
    } finally {
      task.processing = false;
    }
  })();
  return run;
}

async function runStep(task, deps) {
  const judge = deps.judge || defaultJudge;
  const raw = await judge({
    colleagueName: task.colleagueName,
    question: task.question,
    context: task.context,
    options: task.options,
    transcript: task.transcript.slice(),
    followUps: task.followUps,
    maxFollowUps: task.maxFollowUps,
  });
  const parsed = parseJudgeResult(raw);
  if (!parsed) {
    // 判定失败（额度/超时/输出不合规）：不结算、不追问，保持等待 —— 下一条消息会触发重试
    logger.warn('feishu-ask', '判定结果无效（保持等待）', { questionId: task.questionId, followUps: task.followUps });
    return;
  }

  if (parsed.done) {
    logger.info('feishu-ask', '委托得出结论', { questionId: task.questionId, followUps: task.followUps, chars: parsed.conclusion.length });
    settle(task, 'concluded', { conclusion: parsed.conclusion });
    return;
  }

  if (task.followUps >= task.maxFollowUps) {
    settle(task, 'abandoned', { reason: `已追问 ${task.followUps} 轮仍未得出结论` });
    return;
  }

  const creds = (deps.getBotCreds || activeBotCreds)();
  if (!creds) {
    logger.warn('feishu-ask', '无法追问：机器人凭证缺失（保持等待）', { questionId: task.questionId });
    return;
  }
  let ok = false;
  try {
    ok = await (deps.sendText || ((c, openId, text) => sendTextToUser(c, openId, text)))(creds, task.openId, parsed.followUp);
  } catch (e) {
    logger.warn('feishu-ask', '追问发送异常（保持等待）', { questionId: task.questionId, err: e?.message || String(e) });
  }
  if (!ok) {
    logger.warn('feishu-ask', '追问发送失败（保持等待）', { questionId: task.questionId });
    return;
  }
  task.transcript.push({ dir: 'out', text: parsed.followUp, at: new Date().toISOString() });
  task.followUps++;
  safeAppend(deps.appendMessage || appendTo, { id: task.colleagueId, role: task.colleagueRole }, `【追问】${parsed.followUp}`);
  logger.info('feishu-ask', '已自动追问', { questionId: task.questionId, followUps: task.followUps });
}

/**
 * 等待委托结论（阻塞直到 结算/等待超时/运行被停止）。
 *
 * 等待超时与被停止都**取消整个委托**：主 agent 已经不等了，子引擎继续追问就是打扰同事；
 * 迟到的回复从注册表脱落，回落同事对话 agent 的正常流程。
 *
 * @returns {Promise<{status:'concluded'|'abandoned'|'expired'|'timeout'|'aborted'|'busy'|'unknown', conclusion?:string, reason?:string, colleagueName?:string, followUps?:number, transcript?:Array}>}
 */
export function waitForReply(questionId, { timeoutMs, signal, pulse, pulseIntervalMs = 30_000 } = {}) {
  const task = tasks.get(questionId);
  if (!task) return Promise.resolve({ status: 'unknown', reason: '提问不存在或已结束（可能已超时/被取消）' });
  if (task.status !== 'waiting') return Promise.resolve(consume(task));
  if (task.waiter) return Promise.resolve({ status: 'busy', reason: '该提问已在等待中，不要重复等待' });

  const remaining = Math.max(task.expiresAt - Date.now(), 0);
  const requested = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_WAIT_MS;
  const budget = Math.max(Math.min(requested, MAX_WAIT_MS, remaining), 0);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let pulseTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pulseTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const cancel = (status, reason) => {
      task.waiter = null;
      settle(task, 'cancelled', { reason });
      drop(task.questionId);
      finish({ status, reason, colleagueName: task.colleagueName, transcript: task.transcript.slice() });
    };
    const onAbort = () => cancel('aborted', '运行被停止，已取消本次提问');

    task.waiter = (outcome) => finish(buildResult(task, outcome));
    if (budget <= 0) {
      cancel('expired', '提问已过期');
      return;
    }
    timer = setTimeout(() => cancel('timeout', `等待超时（${Math.round(budget / 1000)}s），已取消本次提问`), budget);
    timer.unref?.();
    // 心跳：等待期间 run 没有任何其他事件，没有它会被看门狗当成静默卡死而误杀
    if (typeof pulse === 'function' && pulseIntervalMs > 0) {
      pulse();
      pulseTimer = setInterval(pulse, pulseIntervalMs);
      pulseTimer.unref?.();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
