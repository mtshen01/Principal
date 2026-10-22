/**
 * 子代理句柄注册表（P1-7）运行时 —— per-run，注入式，不 import 任何上层。
 *
 * 职责边界（与 exec-sessions 同形）：
 *  - 本模块管**句柄表 + 邮箱 + 续轮 + 中断 + 状态迁移**，不认识 LLM/provider；
 *    真正跑一轮子代理的是注入的 `runTurn({agent, text, signal})`（装配在 `entrypoints/web/run-openai.js`）；
 *  - 状态显示字段由 `agent-registry.logic.js` 的 reducer 推进（**同一个 reducer 也用于 journal 回放**），
 *    句柄只额外持有运行期私货：message 历史、邮箱、AbortController、drive promise；
 *  - `emit` 把 `agent_status` 事件送进 run-journal（接线 = `emitRunEvent`），只写有界字段。
 *
 * 生命周期（拍板 D3）：绑定本 run。run 收尾 `settleAll`（默认 60s）→ 超时 `interruptAll` 并如实返回条数；
 * 用户中止 → `interruptAll`。**不做跨 run 恢复**：子代理随 run 生灭，落盘只会制造无人认领的悬挂物
 * （与 `feishu-ask` 委托注册表同纪律）。
 *
 * 设计见 `docs/superpowers/specs/2026-10-16-agent-registry-and-handles-design.md`。
 */
import {
  AGENT_MAX_BACKGROUND,
  MAILBOX_MAX,
  SUMMARY_CLIP,
  LIST_SUMMARY_CLIP,
  createAgentState,
  nextAgentId,
  buildAgentName,
  selectAgent,
  applyAgentEvent,
  isTerminal,
  renderAgentList,
  formatSpawnAck,
  formatSendAck,
  formatWaitResult,
  formatWaitTimeout,
  formatInterruptAck,
  formatUnknownAgent,
  formatMailboxFull,
  formatAtCapacity,
  clampWaitMs,
  clipLine,
  AGENT_REGISTRY_TOOL_DEFS,
  AGENT_TOOL_NAMES,
  ERROR_CLIP,
} from './agent-registry.logic.js';
import { clipText } from './web-tools.logic.js';

export { AGENT_TOOL_NAMES };

/** wait_agent 的巡检粒度：每 tick 打一次心跳（看门狗不误杀）并看一眼状态 */
const WAIT_POLL_MS = 1000;
/** abort 之后的收尾宽限：被杀的那一轮应当很快以 interrupted 落定 */
const ABORT_GRACE_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * @param {object} deps
 * @param {(type:string, data:object)=>void} [deps.emit]   journal 事件出口（run-openai 接 emitRunEvent）
 * @param {(line:string)=>void} [deps.activity]            活动转录
 * @param {()=>void} [deps.pulse]                          心跳（等待/后台轮期间刷新 run 看门狗）
 * @param {(p:{agent:object,messages:Array,text:string,signal:AbortSignal})=>Promise<{text?,history?,inputTokens?,outputTokens?,aborted?}>} deps.runTurn
 *   `messages` = 本轮要发的完整序列（不含 system；续轮时已含该 agent 自己的历史）；
 *   返回 `history` = 本轮结束后的完整历史（**不含 system**），下一轮据此接续
 * @param {()=>number} [deps.now]
 */
export function createAgentRegistry({ emit, activity, pulse, runTurn, now = () => Date.now() } = {}) {
  if (typeof runTurn !== 'function') throw new Error('createAgentRegistry 需要注入 runTurn');
  /** 纯状态（显示/归约用）：与 journal 回放同一个 reducer */
  const state = createAgentState();
  /** 运行期句柄（不进 journal 的私货都在这里） */
  const handles = new Map();
  /** 后台轮计数（并发闸只作用于后台发起，拍板 D7） */
  let backgroundActive = 0;

  /** 事件出口：先让 reducer 推进内存状态（非法迁移在此抛），再把同一份数据写 journal */
  function pushEvent(h, status) {
    const data = {
      agentId: h.id,
      name: h.name,
      provider: h.provider,
      role: h.role,
      label: h.label,
      status,
      turns: h.turns,
      ms: h.startedAt && h.endedAt ? Math.max(0, h.endedAt - h.startedAt) : 0,
      inputTokens: h.usage.inputTokens,
      outputTokens: h.usage.outputTokens,
      summaryHead: h.summary ? clipLine(h.summary.replace(/\s+/g, ' '), LIST_SUMMARY_CLIP) : '',
      error: h.error ? clipLine(h.error, ERROR_CLIP) : null,
    };
    const event = { type: 'agent_status', at: now(), data };
    applyAgentEvent(state, event);
    try {
      emit?.(event.type, event.data);
    } catch {
      /* journal 落盘失败绝不影响 agent 驱动（与 emitRunEvent 同纪律）*/
    }
    return event;
  }

  /** 对外视图：纯状态条目（显示字段的事实源）+ 结论全文（只在句柄里） */
  function view(h) {
    const rec = state.agents[h.id] || { id: h.id, name: h.name, status: 'pending' };
    return { ...rec, summary: h.summary, label: h.label, provider: h.provider, role: h.role };
  }

  /** ref（id 或名字）→ 运行期句柄；未命中返回 null（调用方给可读文案，不抛） */
  function resolve(ref) {
    const rec = selectAgent(state, ref);
    return rec ? handles.get(rec.id) || null : null;
  }

  function runningCount() {
    let n = 0;
    for (const h of handles.values()) if (state.agents[h.id]?.status === 'running') n += 1;
    return n;
  }

  /**
   * 跑一轮：状态 running → `runTurn` → 终态。
   * **绝不抛**：失败/中断都在这里收敛成终态，drive 循环据此决定要不要接续邮箱。
   */
  async function runOneTurn(h, text, { signal }) {
    h.turns += 1;
    h.startedAt = now();
    h.endedAt = null;
    h.error = null;
    h.controller = new AbortController();
    // 父 run 的中止派生到本 agent（interrupt_agent 只切自己这一份）
    const linkParent = () => h.controller.abort();
    if (signal) {
      if (signal.aborted) linkParent();
      else signal.addEventListener?.('abort', linkParent, { once: true });
    }
    pushEvent(h, 'running');
    const turnSignal = h.controller.signal;
    // 续轮接续由本模块负责（句柄持有历史）：交给 runTurn 的是**本轮完整消息序列**（不含 system——
    // system 每轮由 runTurn 重建，与主会话同纪律）
    const messages = [...h.history, { role: 'user', content: text }];
    try {
      const out = await runTurn({ agent: view(h), messages, text, signal: turnSignal });
      if (Array.isArray(out?.history)) h.history = out.history;
      h.usage.inputTokens += num(out?.inputTokens);
      h.usage.outputTokens += num(out?.outputTokens);
      const body = String(out?.text || '').trim();
      if (body) h.summary = clipText(body, SUMMARY_CLIP);
      if (turnSignal.aborted || out?.aborted) {
        h.endedAt = now();
        pushEvent(h, 'interrupted');
        return 'interrupted';
      }
      h.endedAt = now();
      pushEvent(h, 'completed');
      return 'completed';
    } catch (e) {
      h.endedAt = now();
      if (turnSignal.aborted) {
        pushEvent(h, 'interrupted');
        return 'interrupted';
      }
      h.error = clipLine(e?.message || String(e), ERROR_CLIP);
      pushEvent(h, 'errored');
      return 'errored';
    } finally {
      signal?.removeEventListener?.('abort', linkParent);
    }
  }

  /**
   * 驱动一个句柄：第一轮 + 邮箱里的接续轮（拍板 D2：运行中收到的消息一定会被执行，不存在「入队了永不触发」）。
   * 邮箱积压多条时**合并成一轮**发出去（逐条各起一轮只会把同一份上下文重复喂给模型）。
   */
  async function drive(h, firstText, { signal, background }) {
    if (background) backgroundActive += 1;
    try {
      let text = firstText;
      for (;;) {
        const status = await runOneTurn(h, text, { signal });
        if (status === 'interrupted') break;
        if (!h.mailbox.length) break;
        text = takeMailbox(h);
      }
    } finally {
      if (background) backgroundActive -= 1;
      h.promise = null;
    }
    return { text: h.summary, status: state.agents[h.id]?.status || 'pending' };
  }

  function takeMailbox(h) {
    const msgs = h.mailbox.splice(0, h.mailbox.length);
    return msgs.map((m) => m.text).join('\n\n');
  }

  function register({ label, provider, role, goal, background }) {
    const id = nextAgentId(state);
    const h = {
      id,
      name: buildAgentName(state, label),
      provider: provider || 'openai-subagent',
      role: role || 'explorer',
      label: String(label || ''),
      goal: String(goal || ''),
      background: !!background,
      turns: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      summary: '',
      error: null,
      history: [],
      mailbox: [],
      startedAt: null,
      endedAt: null,
      controller: null,
      promise: null,
    };
    pushEvent(h, 'pending'); // 先落 pending：journal 里「派过这个子代理」这件事先于第一轮结果
    handles.set(id, h);
    return h;
  }

  /** 后台派发：立即返回（未 await 的 drive 已自带 catch，绝不留未处理 rejection） */
  function spawnBackground({ label, prompt, provider, role, goal }) {
    const body = String(prompt || '').trim();
    if (!body) return { ok: false, text: '错误：prompt 不能为空' };
    if (backgroundActive >= AGENT_MAX_BACKGROUND) return { ok: false, text: formatAtCapacity() };
    const h = register({ label, provider, role, goal, background: true });
    h.promise = drive(h, body, { background: true }).catch(() => {});
    return { ok: true, agent: view(h), text: formatSpawnAck(view(h)) };
  }

  /**
   * 阻塞派发（现有 `Task` / `Workflow` 语义）：返回该轮的 promise，调用方 await 拿结论。
   * `signal` = 父 run 的中止信号（派生给本 agent）。
   */
  async function spawnBlocking({ label, prompt, provider, role, goal, signal }) {
    const body = String(prompt || '').trim();
    if (!body) return { text: '（子代理未产出结论）', status: 'errored' };
    const h = register({ label, provider, role, goal, background: false });
    h.promise = drive(h, body, { signal, background: false });
    return h.promise;
  }

  function send(agentId, text) {
    const h = resolve(agentId);
    if (!h) return { ok: false, text: formatUnknownAgent(agentId) };
    const body = String(text || '').trim();
    if (!body) return { ok: false, text: '错误：message 不能为空' };
    const status = state.agents[h.id]?.status;
    if (status === 'running' || status === 'pending') {
      if (h.mailbox.length >= MAILBOX_MAX) return { ok: false, text: formatMailboxFull(view(h)) };
      h.mailbox.push({ at: now(), text: body });
      return { ok: true, mode: 'queued', text: formatSendAck(view(h), 'queued') };
    }
    // 空闲 → 起新一轮（新的一轮是「后台」量级：父模型不阻塞在这上面）
    if (backgroundActive >= AGENT_MAX_BACKGROUND) return { ok: false, text: formatAtCapacity() };
    h.promise = drive(h, body, { background: true }).catch(() => {});
    return { ok: true, mode: 'started', text: formatSendAck(view(h), 'started') };
  }

  /**
   * 等待收尾：按 `WAIT_POLL_MS` 巡检 + 心跳；超时如实返回「仍在运行」而不是一直挂住
   *（父模型的一步被占住，卡死比「等不到」严重得多）。
   */
  async function wait(agentId, { timeoutMs, signal } = {}) {
    const h = resolve(agentId);
    if (!h) return { ok: false, text: formatUnknownAgent(agentId) };
    const limit = clampWaitMs(timeoutMs);
    const deadline = now() + limit;
    for (;;) {
      if (isTerminal(state.agents[h.id]?.status)) return { ok: true, agent: view(h), timedOut: false };
      if (signal?.aborted) return { ok: true, agent: view(h), timedOut: false, aborted: true };
      const remain = deadline - now();
      if (remain <= 0) return { ok: true, agent: view(h), timedOut: true, timeoutMs: limit };
      pulse?.();
      await sleep(Math.min(WAIT_POLL_MS, remain));
    }
  }

  function interrupt(agentId) {
    const h = resolve(agentId);
    if (!h) return { ok: false, text: formatUnknownAgent(agentId) };
    const status = state.agents[h.id]?.status;
    if (status !== 'running' && status !== 'pending') return { ok: true, changed: false, agent: view(h), text: formatInterruptAck(view(h), false) };
    h.controller?.abort();
    if (status === 'pending') {
      // 从未开跑（注册后 run 立刻收尾）：没有可 abort 的东西，直接落终态
      h.endedAt = now();
      pushEvent(h, 'interrupted');
      return { ok: true, changed: true, agent: view(h), text: formatInterruptAck(view(h), true) };
    }
    // 运行中：不在这里改状态——那一轮自己会以 interrupted 落定（状态迁移只有一个写者）
    return { ok: true, changed: true, agent: view(h), text: formatInterruptAck(view(h), true) };
  }

  /** 中止全部（run 收尾/用户中止的兜底）：幂等 */
  function interruptAll() {
    let n = 0;
    for (const h of handles.values()) {
      const status = state.agents[h.id]?.status;
      if (status === 'running' || status === 'pending') {
        interrupt(h.id);
        n += 1;
      }
    }
    return { count: n };
  }

  /**
   * run 收尾前等后台子代理：`timeoutMs` 内没结束的一律 abort（活动行由调用方写）。
   * 为什么不死等：一个后台子代理不该无限推迟主 run 的收尾；为什么不让它继续跑：
   * run 都结束了，它的结论没有任何出口，只会白烧额度。
   */
  async function settleAll({ timeoutMs = 60_000 } = {}) {
    const pendingOf = () => [...handles.values()].filter((h) => state.agents[h.id]?.status === 'running');
    const first = pendingOf();
    if (!first.length) return { aborted: 0, waited: 0 };
    const startedAt = now();
    await Promise.race([
      Promise.allSettled(first.map((h) => h.promise).filter(Boolean)),
      sleep(timeoutMs),
    ]);
    const survivors = pendingOf();
    if (!survivors.length) return { aborted: 0, waited: now() - startedAt };
    for (const h of survivors) interrupt(h.id);
    await Promise.race([
      Promise.allSettled(survivors.map((h) => h.promise).filter(Boolean)),
      sleep(ABORT_GRACE_MS),
    ]);
    activity?.(`⚠️ ${survivors.length} 个后台子代理超过 ${Math.round(timeoutMs / 1000)}s 仍未收尾，已随本轮结束中断（未取回的结论已丢弃）`);
    return { aborted: survivors.length, waited: now() - startedAt };
  }

  const list = () => (state.order || []).map((id) => view(handles.get(id))).filter(Boolean);
  const get = (ref) => {
    const h = resolve(ref);
    return h ? view(h) : null;
  };

  async function executeTool(name, input = {}) {
    switch (name) {
      case 'send_message':
        return send(input.agent_id, input.message).text;
      case 'wait_agent': {
        // 这里**不能**用父 run 的中止信号打断巡检：wait 的可中断语义由 agent 自身终态体现
        //（父中止会先派生到 agent → agent 终态 → 巡检立即返回）。
        const r = await wait(input.agent_id, { timeoutMs: input.timeout_ms });
        if (!r.ok) return r.text;
        return r.timedOut ? `${formatWaitTimeout(r.agent, r.timeoutMs)}\n\n${renderAgentList(state)}` : formatWaitResult(r.agent);
      }
      case 'interrupt_agent':
        return interrupt(input.agent_id).text;
      case 'list_agents':
        return renderAgentList(state);
      default:
        return `错误：未知工具 ${name}`;
    }
  }

  return {
    toolDefs: AGENT_REGISTRY_TOOL_DEFS,
    executeTool,
    spawnBackground,
    spawnBlocking,
    send,
    wait,
    interrupt,
    interruptAll,
    settleAll,
    list,
    get,
    /** 纯状态快照（测试/排障用） */
    snapshot: () => state,
    /** 当前在跑的子代理数（后台闸与测试用） */
    stats: () => ({ backgroundActive, running: runningCount(), total: handles.size }),
  };
}

const num = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
