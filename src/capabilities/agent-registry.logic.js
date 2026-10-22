/**
 * 子代理句柄注册表纯函数层（P1-7，Codex `AgentHandle` 对位）。
 *
 * 背景：`Task`/`Workflow` 的子代理此前是「一次工具调用，用完全忘」——本轮派过几个、谁成功谁失败、
 * 花了多少 token、结论摘要是什么，事后无处可查；也不能追问（重派等于把上一轮读过的文件重读一遍）、
 * 不能单独掐断（只有整个 run 的 abort）。本模块把子代理变成**有地址、有状态、可续轮**的实体。
 *
 * 分层（与 exec-sessions 同形）：状态机/命名/归约/文案/工具 schema 全是纯函数（本文件，零 IO，
 * 可 `node --test` 直测）；句柄表/邮箱/续轮/中断的实际驱动在 `agent-registry.js`；
 * 接入 run 的装配在 `entrypoints/web/run-openai.js`。设计见
 * `docs/superpowers/specs/2026-10-16-agent-registry-and-handles-design.md`。
 *
 * 归约（`reduceAgentEvents`）刻意与运行时同源（同一个 `applyAgentEvent`）：journal 里的事实与
 * 内存里的状态是同一套规则算出来的，回放/排障看到的就是当时的状态。
 */
import { z } from 'zod';

/** agent 的命名根（Codex 是 /root/<task>；本项目子代理只有一层，父恒为 /root） */
export const AGENT_NAME_ROOT = '/root';
/** 一个 run 同时能跑的后台子代理上限（Codex V2 每 session 并发 4）；阻塞式 Task/Workflow 不受此闸约束 */
export const AGENT_MAX_BACKGROUND = 4;
/** 运行中的 agent 邮箱上限：超了说明父模型在刷消息，明确拒绝而不是无限堆积 */
export const MAILBOX_MAX = 8;
/** wait_agent 默认/上下界（Codex 默认 30s；上界收到 300s——等待期间父模型的一步被占住） */
export const WAIT_DEFAULT_MS = 30_000;
export const WAIT_MIN_MS = 1_000;
export const WAIT_MAX_MS = 300_000;
/** 结论回传主模型的上限（沿用 A7 的 8000 字符口径）；列表里每条摘要的上限；错误文案上限 */
export const SUMMARY_CLIP = 8000;
export const LIST_SUMMARY_CLIP = 60;
export const ERROR_CLIP = 200;

/**
 * 头截断（一行场景专用）。
 * 刻意**不用** `web-tools.logic.js#clipText`：那是「保头尾 + 标注略去字数」的中段截断，
 * 会往结果里插换行——用在名字/列表行/错误一行上会把表格撕开。
 */
const head = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
};

/** 同上，导出给运行时组 journal 事件用（`summaryHead`/`error` 都必须是一行且有界） */
export const clipLine = head;

export const AGENT_STATUSES = Object.freeze(['pending', 'running', 'completed', 'errored', 'interrupted']);
const TERMINAL = new Set(['completed', 'errored', 'interrupted']);

/** 终态判定：终态是事实，不能复活（send_message 起的是**新的一轮**，不是把旧轮改活） */
export function isTerminal(status) {
  return TERMINAL.has(String(status || ''));
}

/**
 * 合法迁移表。解释：
 *  - pending：尚未开跑（注册了但 run 已收尾就会停在 pending → interrupted）；
 *  - running → 三个终态；
 *  - 终态 → running：`send_message` 给空闲 agent 起新一轮（turns 递增，旧轮的终态事实已在 journal 里）。
 * 非法迁移是代码 bug，`applyAgentEvent` 直接抛——不静默把状态机擦成任意值。
 */
const TRANSITIONS = Object.freeze({
  pending: Object.freeze(['running', 'interrupted', 'errored']),
  running: Object.freeze(['completed', 'errored', 'interrupted']),
  completed: Object.freeze(['running']),
  errored: Object.freeze(['running']),
  interrupted: Object.freeze(['running']),
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** 纯状态容器：agents 表 + 序号 + 插入序（列表按派发顺序展示） */
export function createAgentState() {
  return { seq: 0, order: [], agents: {} };
}

/** 短 id（寻址主键）：a1、a2…；与 journal 里的 id 一致 */
export function nextAgentId(state) {
  return `a${(state?.seq || 0) + 1}`;
}

/** 短说明 → 名字片段：空白/斜杠收成 `-`，无可用字符则 `agent`（中文照留，名字是给人看的） */
export function slugifyAgentLabel(label) {
  const s = String(label || '')
    .trim()
    .replace(/[\s/\\]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return head(s, 24) || 'agent';
}

/**
 * 层级名字（可读 + 可寻址）：`/root/<slug>-<n>`，n 取本轮派发序号保证唯一。
 * 与 id 的关系：id 是机器主键（短、稳定），name 是人读地址（模型在自然语言里引用它）。
 */
export function buildAgentName(state, label) {
  return `${AGENT_NAME_ROOT}/${slugifyAgentLabel(label)}-${(state?.seq || 0) + 1}`;
}

/** 按 id 或 name 找 agent（先 id 后 name；未命中返回 null，调用方给可读文案） */
export function selectAgent(state, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  const agents = state?.agents || {};
  if (Object.hasOwn(agents, key)) return agents[key];
  for (const id of state?.order || []) {
    if (agents[id]?.name === key) return agents[id];
  }
  return null;
}

/**
 * 归约一条 `agent_status` 事件（运行时与回放共用）。事件形状：
 * `{ type:'agent_status', at, data:{ agentId, name, provider, role, label, status, turns, ms, inputTokens, outputTokens, summaryHead, error? } }`
 *
 * 未知 agentId 视为「首次出现」（journal 从中间读起也照样重建）；身份字段只在首次落地，
 * 后续事件不覆盖（名字/角色不随后续事件变）。
 *
 * 注意：事件里放的是**有界的**展示字段（`summaryHead` clip 60 / `error` clip 60），不放结论全文——
 * journal 是事实骨架，结论全文在句柄里（内存），与 `truncateForJournal` 同纪律。
 */
export function applyAgentEvent(state, ev) {
  const d = ev?.data && typeof ev.data === 'object' ? ev.data : {};
  const status = String(d.status || '');
  if (!AGENT_STATUSES.includes(status)) throw new Error(`未知 agent 状态：${d.status}`);
  const id = String(d.agentId || '');
  if (!id) throw new Error('agent_status 事件缺少 agentId');
  const at = Number.isFinite(ev?.at) ? ev.at : null;
  const existing = state.agents[id];
  if (!existing) {
    state.agents[id] = {
      id,
      name: String(d.name || id),
      provider: String(d.provider || 'openai-subagent'),
      role: String(d.role || 'explorer'),
      label: String(d.label || ''),
      status,
      turns: num(d.turns),
      usage: { inputTokens: num(d.inputTokens), outputTokens: num(d.outputTokens) },
      startedAt: status === 'running' ? at : null,
      ms: num(d.ms),
      summaryHead: head(String(d.summaryHead || ''), LIST_SUMMARY_CLIP),
      error: d.error ? head(String(d.error), ERROR_CLIP) : null,
      lastAt: at,
    };
    state.order.push(id);
    state.seq = Math.max(state.seq, numericSuffix(id));
    return state;
  }
  if (existing.status !== status && !canTransition(existing.status, status)) {
    throw new Error(`非法 agent 状态迁移：${existing.status} → ${status}（${id}）`);
  }
  existing.status = status;
  existing.turns = num(d.turns) || existing.turns;
  existing.usage = {
    inputTokens: num(d.inputTokens) || existing.usage.inputTokens,
    outputTokens: num(d.outputTokens) || existing.usage.outputTokens,
  };
  // 「已跑多久」看**当前这一轮**的起点：终态后停在这一轮的 startedAt 上，重启一轮会刷新
  if (status === 'running') existing.startedAt = at ?? existing.startedAt;
  existing.ms = num(d.ms) || existing.ms;
  if (d.summaryHead) existing.summaryHead = head(String(d.summaryHead), LIST_SUMMARY_CLIP);
  if (d.error) existing.error = head(String(d.error), ERROR_CLIP);
  if (at != null) existing.lastAt = at;
  return state;
}

/** journal 事件数组 → 状态（同一个 reducer；用于离线回放/排障） */
export function reduceAgentEvents(events = []) {
  const state = createAgentState();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.type !== 'agent_status') continue;
    applyAgentEvent(state, ev);
  }
  return state;
}

const num = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const numericSuffix = (id) => {
  const m = /^a(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : 0;
};

// ---------- 文案（工具结果与活动行只此一份，避免两处口径分叉） ----------

export function formatDuration(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0));
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60_000);
  return `${m}m${Math.round((n - m * 60_000) / 1000)}s`;
}

export function formatAgentLine(agent, { now = Date.now() } = {}) {
  if (!agent) return '（未知子代理）';
  const parts = [agent.id, agent.name, statusLabel(agent.status)];
  if (agent.status === 'running') parts.push(`已跑 ${formatDuration(now - (agent.startedAt || now))}`);
  else if (agent.ms) parts.push(formatDuration(agent.ms));
  if (agent.turns > 1) parts.push(`${agent.turns} 轮`);
  const tokens = (agent.usage?.inputTokens || 0) + (agent.usage?.outputTokens || 0);
  if (tokens) parts.push(`${tokens} tokens`);
  const tail = agent.error ? `错误：${agent.error}` : head(String(agent.summaryHead || '').replace(/\s+/g, ' '), LIST_SUMMARY_CLIP);
  return `- ${parts.join(' · ')}${tail ? ` · ${tail}` : ''}`;
}

const STATUS_LABELS = Object.freeze({
  pending: '未开始',
  running: '运行中',
  completed: '已完成',
  errored: '失败',
  interrupted: '已中断',
});
export function statusLabel(status) {
  return STATUS_LABELS[String(status || '')] || String(status || '未知');
}

/** `list_agents` 的结果文本（列表是索引，不是内容：摘要只给一行） */
export function renderAgentList(state, { now = Date.now() } = {}) {
  const lines = [];
  for (const id of state?.order || []) {
    const a = state.agents[id];
    if (a) lines.push(formatAgentLine(a, { now }));
  }
  if (!lines.length) return '（本轮还没有派过子代理；要派就用 Task，可选 background:true 后台跑）';
  return [`本轮子代理（${lines.length} 个）：`, ...lines].join('\n');
}

export function formatSpawnAck(agent) {
  return (
    `✅ 已后台派发子代理 ${agent.id}「${agent.label || agent.name}」（${agent.name}），它正在独立跑。\n` +
    `取结论：wait_agent { agent_id: "${agent.id}" }；追加要求：send_message；掐断：interrupt_agent；看全局：list_agents。`
  );
}

export function formatSendAck(agent, mode) {
  if (mode === 'queued') {
    return `✅ 已投递给子代理 ${agent.id}（它正在跑第 ${agent.turns} 轮，本轮结束后自动接续）。用 wait_agent 取结论。`;
  }
  return `✅ 已给子代理 ${agent.id} 起第 ${agent.turns} 轮。用 wait_agent { agent_id: "${agent.id}" } 取结论。`;
}

export function formatWaitTimeout(agent, timeoutMs) {
  const running = agent?.status === 'running';
  return (
    `⌛ 等待 ${formatDuration(timeoutMs)} 后子代理 ${agent?.id || '?'} 仍在运行（第 ${agent?.turns || 1} 轮）。\n` +
    (running ? '可以继续等（再调 wait_agent），或先干别的、稍后用 list_agents 看状态；结论不会丢。' : '')
  );
}

/** 等待结果：这里的 `agent` 是**运行时视图**（纯状态条目 + 结论全文 `summary`），其余文案函数只吃纯状态条目 */
export function formatWaitResult(agent) {
  if (agent.status === 'completed') return agent.summary || '（子代理未产出结论）';
  // 中断/失败时把**已产出的部分结论**带上：半截结论也比一句「失败了」有用，但也如实标注它是残的
  const partial = agent.summary ? `\n\n已产出的部分结论（可能不完整）：\n${agent.summary}` : '';
  if (agent.status === 'interrupted') return `❌ 子代理 ${agent.id} 已被中断（第 ${agent.turns} 轮未完成）${partial}`;
  if (agent.status === 'errored') return `❌ 子代理 ${agent.id} 执行失败：${agent.error || '未知错误'}${partial}`;
  return `（子代理 ${agent.id} 仍在运行）`;
}

export function formatInterruptAck(agent, changed) {
  if (!changed) {
    return `子代理 ${agent.id} 当前没有在跑（${statusLabel(agent.status)}），无需中断。`;
  }
  return `🛑 已中断子代理 ${agent.id}（第 ${agent.turns} 轮）。它的邮箱与已探查的历史都还在，可以 send_message 让它带着这些继续。`;
}

export function formatUnknownAgent(ref) {
  return `未知子代理：${head(String(ref ?? ''), 40) || '(空)'}。用 list_agents 看本轮派过哪些（要用 agent_id 或名字，不是描述）。`;
}

export function formatMailboxFull(agent) {
  return `子代理 ${agent.id} 的邮箱已满（${MAILBOX_MAX} 条未消费）。先 wait_agent 收一轮结论，再继续发。`;
}

export function formatAtCapacity() {
  return `后台子代理已达上限（${AGENT_MAX_BACKGROUND} 个在跑）。先 wait_agent / interrupt_agent 收掉一些，或用阻塞式 Task（不带 background）。`;
}

/** wait_agent 的等待时长夹取：缺省 30s，1s–300s */
export function clampWaitMs(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_MS;
  return Math.min(Math.max(n, WAIT_MIN_MS), WAIT_MAX_MS);
}

// ---------- 工具定义（schema 纯数据；执行在 agent-registry.js） ----------

export const AGENT_TOOL_NAMES = Object.freeze(['send_message', 'wait_agent', 'interrupt_agent', 'list_agents']);

export const AGENT_REGISTRY_TOOL_DEFS = Object.freeze({
  send_message: {
    description:
      '给一个子代理发消息。它空闲（已完成/失败/被中断）就起新一轮——**它自己的探查历史还在**，所以追问比重新派一个 Task 便宜得多；' +
      '它正在跑就入队，当前轮结束后自动接续。本工具不阻塞：发完用 wait_agent 取结论。',
    inputSchema: z.object({
      agent_id: z.string().describe('子代理 id（如 a1）或名字（如 /root/支付模块审查-1）'),
      message: z.string().describe('要发给它的内容（它看不到主会话历史，写清楚要什么）'),
    }),
  },
  wait_agent: {
    description:
      '等待一个子代理收尾并取回它的结论（默认等 30 秒，最长 5 分钟）。超时会如实告诉你「仍在运行」而不是一直卡住——' +
      '可以再等一次，或先干别的、稍后用 list_agents 看状态。子代理已结束则立即返回结论。',
    inputSchema: z.object({
      agent_id: z.string().describe('子代理 id 或名字'),
      timeout_ms: z.coerce.number().int().optional().describe('本次等待毫秒数（默认 30000，范围 1000–300000）'),
    }),
  },
  interrupt_agent: {
    description:
      '中断一个正在跑的子代理（连同它当前的模型请求）。它已经探查到的历史与未消费的消息都保留，可以之后 send_message 让它继续。',
    inputSchema: z.object({
      agent_id: z.string().describe('子代理 id 或名字'),
    }),
  },
  list_agents: {
    description: '列出本轮派发过的子代理：id、名字、状态（未开始/运行中/已完成/失败/已中断）、耗时、轮数、token、结论摘要。',
    inputSchema: z.object({}),
  },
});
