/**
 * Run 回放 reducer（P1-12，spec `docs/superpowers/specs/2026-10-11-request-snapshot-and-run-replay-design.md`）。
 *
 * 把 run-journal（事实流，追加写）归约成一条「一屏可读」的时间线：run 状态、steer 生命周期、
 * 压缩点、模型流重试、审批问答、policy 拦截、token 曲线。对齐 Codex 的做法：热路径只写原始事件，
 * 解释放到离线 reducer——排查时不必再 grep jsonl，压缩点与 usage 曲线也能直接在时间线上对齐。
 *
 * 纪律：**只读、纯函数、零 IO**（读文件由调用方做：CLI 走 store/run-journal.js#readRunEvents）。
 * 事件映射是白名单式：未知 type 记入 `unknownTypes` 而不抛错——journal 加新事件不炸回放，补映射即可。
 */

/**
 * @typedef {object} RunTimeline
 * @property {string|null} runId
 * @property {string|null} convId
 * @property {'done'|'error'|'interrupted'|'unsettled'|'unknown'|string} status settled 缺失但事件非空时记 'unsettled'（崩溃现场）
 */

const arr = (v) => (Array.isArray(v) ? v : []);

/** 取事件 payload（坏 data 一律视作空对象；reducer 不因脏数据抛错） */
const data = (e) => (e && typeof e.data === 'object' && e.data ? e.data : {});

/**
 * 归约：journal 事件（任意顺序，按 runId 过滤由调用方或本函数完成）→ 时间线。
 * @param {Array<{type:string, seq?:number, runId?:string, convId?:string, at?:number, data?:object}>} events
 * @returns {RunTimeline}
 */
export function reduceRunTimeline(events = []) {
  // 单 run 输入假设 + 防御收口：以**首个事件**的 runId 为准，其余 runId 的事件剔除
  // （调用方正常传 readRunEvents(runId) 的结果；混入他 run / 无 runId 的事件时行为仍确定）。
  const all = arr(events).filter((e) => e && typeof e === 'object' && e.runId);
  const canonicalRunId = all[0]?.runId ?? null;
  const list = canonicalRunId ? all.filter((e) => e.runId === canonicalRunId) : [];
  const t = {
    runId: canonicalRunId,
    convId: null,
    status: 'unknown',
    submittedAt: null,
    endedAt: null,
    durationMs: null,
    firstSeq: null,
    lastSeq: null,
    eventCount: list.length,
    unknownTypes: [],
    meta: null,
    startedPid: null,
    sessionId: null,
    resumes: [],
    tokens: [],
    compactions: [],
    retries: [],
    results: [],
    asks: [],
    decisions: [],
    policyBlocks: [],
    steer: { held: [], withdrawn: [], consumed: [], unsent: [] },
    followUps: { queued: [], cancelled: [], started: [] },
    agents: [],
    settled: null,
  };
  const unknown = new Set();
  for (const e of list) {
    const d = data(e);
    const at = Number.isFinite(e.at) ? e.at : null;
    if (!t.convId && e.convId) t.convId = e.convId;
    if (t.firstSeq == null && Number.isFinite(e.seq)) t.firstSeq = e.seq;
    if (Number.isFinite(e.seq)) t.lastSeq = e.seq;
    switch (e.type) {
      case 'submitted':
        t.submittedAt = at;
        t.meta = {
          provider: d.provider ?? null,
          model: d.model ?? null,
          effort: d.effort ?? null,
          mode: d.mode ?? null,
          ultracode: d.ultracode === true,
          cwd: d.cwd ?? null,
          requestId: d.requestId ?? null,
          resumeAttempt: d.resumeAttempt ?? 0,
        };
        break;
      case 'started':
        t.startedPid = d.pid ?? null;
        break;
      case 'resumed':
        t.resumes.push({
          at,
          fromRunId: d.fromRunId ?? null,
          attempt: d.attempt ?? null,
          reason: d.reason ?? null,
        });
        break;
      case 'session':
        t.sessionId = d.session_id ?? null;
        break;
      case 'usage':
        t.tokens.push({
          at,
          step: d.step ?? null,
          inputTokens: d.inputTokens ?? null,
          outputTokens: d.outputTokens ?? null,
          totalTokens: d.totalTokens ?? null,
          model: d.model ?? null,
          contextWindow: d.contextWindow ?? null,
        });
        break;
      case 'compaction':
        t.compactions.push({
          at,
          reason: d.reason ?? null,
          tokensBefore: d.tokensBefore ?? null,
          tokensAfter: d.tokensAfter ?? null,
          window: d.window ?? null,
          limit: d.limit ?? null,
          visibleBefore: d.visibleBefore ?? null,
          coveredBefore: d.coveredBefore ?? null,
          coveredAfter: d.coveredAfter ?? null,
          kept: d.kept ?? null,
          summaryChars: d.summaryChars ?? null,
          model: d.model ?? null,
        });
        break;
      case 'model_retry':
        t.retries.push({
          at,
          retry: d.retry ?? null,
          max: d.max ?? null,
          delayMs: d.delayMs ?? null,
          kind: d.kind ?? null,
          error: d.error ?? null,
        });
        break;
      case 'steer':
        t.steer.held.push({ at, msgId: d.msgId ?? null, text: d.text ?? '' });
        break;
      case 'steer_withdrawn':
        t.steer.withdrawn.push({ at, msgId: d.msgId ?? null });
        break;
      case 'steer_consumed':
        t.steer.consumed.push({ at, msgIds: arr(d.msgIds).slice(), via: d.via ?? null });
        break;
      case 'steer_unsent':
        t.steer.unsent.push({ at, msgIds: arr(d.msgIds).slice() });
        break;
      case 'follow_up':
        t.followUps.queued.push({ at, id: d.id ?? null, text: d.text ?? '', source: d.source ?? null });
        break;
      case 'follow_up_cancelled':
        t.followUps.cancelled.push({ at, id: d.id ?? null });
        break;
      case 'follow_up_started':
        t.followUps.started.push({
          at,
          ids: arr(d.ids).slice(),
          count: d.count ?? null,
          fromRunId: d.fromRunId ?? null,
          source: d.source ?? null,
        });
        break;
      case 'agent_status':
        // 子代理句柄（P1-7）：状态迁移按发生顺序平铺，不在这里聚合——聚合归 reduceAgentEvents，
        // 回放要的是「什么时刻发生了什么」，聚合态会把这个信息抹掉
        t.agents.push({
          at,
          agentId: d.agentId ?? null,
          name: d.name ?? null,
          role: d.role ?? null,
          provider: d.provider ?? null,
          status: d.status ?? null,
          turns: d.turns ?? null,
          ms: d.ms ?? null,
          tokens: (Number(d.inputTokens) || 0) + (Number(d.outputTokens) || 0) || null,
          summaryHead: d.summaryHead ?? null,
          error: d.error ?? null,
        });
        break;
      case 'ask':
        t.asks.push({ at, reqId: d.reqId ?? null, kind: d.kind ?? null, title: d.title ?? null });
        break;
      case 'decision':
        t.decisions.push({ at, reqId: d.reqId ?? null, choice: d.choice ?? null, via: d.via ?? null });
        break;
      case 'policy_block':
        t.policyBlocks.push({
          at,
          tool: d.tool ?? null,
          klass: d.klass ?? null,
          ruleId: d.ruleId ?? null,
          reason: d.reason ?? null,
          count: d.count ?? null,
        });
        break;
      case 'result':
        t.results.push({
          at,
          subtype: d.subtype ?? null,
          isError: d.isError === true,
          inputTokens: d.inputTokens ?? null,
          outputTokens: d.outputTokens ?? null,
        });
        break;
      case 'settled':
        t.settled = {
          at,
          status: d.status ?? null,
          subtype: d.subtype ?? null,
          attempts: d.attempts ?? null,
        };
        t.endedAt = at;
        break;
      default:
        unknown.add(String(e.type ?? '(missing)'));
    }
  }
  // 状态口径（拍板 #7）：settled 存在 → 其 status；无 settled 但有事件 → unsettled（崩溃现场）；否则 unknown
  if (t.settled) t.status = t.settled.status || 'done';
  else if (list.length) t.status = 'unsettled';
  if (t.submittedAt != null && t.endedAt != null) {
    t.durationMs = Math.max(0, t.endedAt - t.submittedAt);
  }
  t.unknownTypes = [...unknown];
  return t;
}

const ts = (at) => (at == null ? '?' : new Date(at).toISOString());
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * 时间线 → 人读行数组（每行一个事实；CLI 直接逐行打印）。
 * @param {RunTimeline} t
 * @returns {string[]}
 */
export function formatRunTimeline(t) {
  if (!t || !t.runId) return ['(无事件)'];
  const m = t.meta || {};
  const lines = [];
  const head = [
    m.provider || '?',
    m.model || '?',
    m.effort ? `effort=${m.effort}` : '',
    m.mode ? `mode=${m.mode}` : '',
    m.ultracode ? 'ultracode' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const dur = t.durationMs != null ? `，${secs(t.durationMs)}` : '';
  lines.push(`[${t.runId}] ${head} → ${t.status}（${t.eventCount} 事件${dur}）`);
  if (t.submittedAt != null) {
    lines.push(`  submitted ${ts(t.submittedAt)}${m.cwd ? ` cwd=${m.cwd}` : ''}${m.requestId ? ` requestId=${m.requestId}` : ''}`);
  }
  for (const r of t.resumes) {
    lines.push(`  resumed #${r.attempt ?? '?'}（${r.reason || '?'}${r.fromRunId ? `，来自 ${r.fromRunId}` : ''}）`);
  }
  for (const u of t.tokens) {
    lines.push(
      `  tokens step=${u.step ?? '?'} in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'}` +
        `${u.totalTokens != null ? ` total=${u.totalTokens}` : ''}${u.contextWindow ? ` window=${u.contextWindow}` : ''}`,
    );
  }
  for (const c of t.compactions) {
    lines.push(
      `  compact ${c.reason || '?'} ${c.tokensBefore ?? '?'}→${c.tokensAfter ?? '?'} tokens` +
        `${c.kept != null ? ` kept=${c.kept}` : ''}${c.coveredAfter != null ? ` covered=${c.coveredAfter}` : ''}`,
    );
  }
  for (const r of t.retries) {
    lines.push(`  retry #${r.retry ?? '?'}/${r.max ?? '?'} ${r.kind || '?'} ${r.delayMs ?? '?'}ms${r.error ? `：${r.error}` : ''}`);
  }
  for (const h of t.steer.held) lines.push(`  steer+ ${h.msgId ?? '?'}：「${h.text}」`);
  for (const w of t.steer.withdrawn) lines.push(`  steer- ${w.msgId ?? '?'}`);
  for (const c of t.steer.consumed) lines.push(`  steer→ ${c.msgIds.join(',') || '?'}（${c.via || '?'}）`);
  for (const u of t.steer.unsent) lines.push(`  steer✗ ${u.msgIds.join(',') || '?'}`);
  for (const f of t.followUps.queued) lines.push(`  follow-up+ ${f.id ?? '?'}：「${f.text}」`);
  for (const f of t.followUps.cancelled) lines.push(`  follow-up- ${f.id ?? '?'}`);
  for (const f of t.followUps.started) {
    lines.push(`  follow-up▶ ${f.ids.join(',') || '?'}（${f.count ?? '?'} 条${f.fromRunId ? `，来自 ${f.fromRunId}` : ''}）`);
  }
  for (const a of t.agents) {
    lines.push(
      `  agent ${a.agentId ?? '?'}${a.name ? ` ${a.name}` : ''} → ${a.status || '?'}` +
        `${a.turns ? ` 第${a.turns}轮` : ''}${a.ms ? ` ${secs(a.ms)}` : ''}${a.tokens ? ` ${a.tokens} tokens` : ''}` +
        `${a.error ? ` 错误：${a.error}` : a.summaryHead ? `：${a.summaryHead}` : ''}`,
    );
  }
  for (const a of t.asks) lines.push(`  ask ${a.reqId ?? '?'} ${a.kind || '?'}${a.title ? ` ${a.title}` : ''}`);
  for (const d of t.decisions) lines.push(`  decision ${d.reqId ?? '?'} → ${d.choice || '?'}${d.via ? `（${d.via}）` : ''}`);
  for (const b of t.policyBlocks) {
    lines.push(`  blocked ${b.tool || '?'}（${b.klass || '?'}${b.ruleId ? `/${b.ruleId}` : ''}）${b.count ? `×${b.count}` : ''}`);
  }
  for (const r of t.results) {
    lines.push(`  result ${r.subtype || '?'}${r.isError ? '（error）' : ''} in=${r.inputTokens ?? '?'} out=${r.outputTokens ?? '?'}`);
  }
  if (t.settled) {
    lines.push(`  settled ${t.settled.status || '?'}${t.settled.subtype ? `/${t.settled.subtype}` : ''}${t.settled.attempts ? ` attempts=${t.settled.attempts}` : ''}`);
  }
  if (t.unknownTypes.length) lines.push(`  （未知事件类型：${t.unknownTypes.join(', ')}）`);
  return lines;
}
