/**
 * 命令会话管理（P1-6）纯函数层 —— 输出缓冲 / yield 夹取 / 工具结果文案（零 IO，可离线单测）。
 *
 * 背景与口径：`docs/superpowers/specs/2026-10-11-exec-sessions-design.md`（Codex unified_exec 对位）。
 * 运行时（spawn/登记表/terminateAll）在 exec-sessions.js；本模块只做「数字与文字」。
 *
 * 缓冲语义（对齐 Codex 的 head_tail_buffer）：
 * - stdout/stderr 按到达序合并进**单个**缓冲（终端观感；会话场景里交错的提示与报错比流归属更重要）；
 * - 超过上限时保留**头**（首 16K 字：命令回显/早期错误）与**尾**（末 112K 字：最新进展），
 *   中段累计进 `dropped`，在下一次读取时以省略标记显式报告（不假装没发生）；
 * - 读取是**消费式**：读走即清；单次 ≤ 8K 字，剩余附「续读」提示（模型据此决定再轮询还是收尾）。
 */

/** 会话参数与上限（导出供运行时与测试共用；改这里即改行为） */
export const SESSIONS = Object.freeze({
  DEFAULT_YIELD_MS: 10_000, // exec_command 默认等待时间片（Codex MIN/MAX 250ms–30s、默认 10s 对位）
  WRITE_DEFAULT_YIELD_MS: 5_000, // write_stdin 默认：纯轮询不该等满 10s
  MIN_YIELD_MS: 250,
  MAX_YIELD_MS: 30_000,
  READ_CAP_CHARS: 8_000, // 单次读取上限（报告口径「流式增量 ≤ 8KB」）
  HEAD_KEEP_CHARS: 16_000, // 头保留
  TAIL_KEEP_CHARS: 112_000, // 尾保留（两段合计 128K 字）
  MAX_SESSIONS: 8, // 每 run 会话上限（Codex 全局 64；我们 per-run 收敛，run 结束全杀）
  EXIT_GRACE_MS: 100, // 进程 exit 后等待 close 的宽限（孙进程持管道时 close 可能不来）
});

// ---------- 输出缓冲 ----------

/** 新缓冲状态（普通对象，便于测试断言与序列化） */
export function createBuffer() {
  return { text: '', dropped: 0 };
}

/** 追加一段输出；超限时剪中段（保留头尾），丢弃量累计到 state.dropped */
export function bufferAppend(state, chunk) {
  const s = String(chunk ?? '');
  if (!s) return state;
  state.text += s;
  const total = SESSIONS.HEAD_KEEP_CHARS + SESSIONS.TAIL_KEEP_CHARS;
  if (state.text.length > total) {
    const cut = state.text.length - total;
    state.dropped += cut;
    // 上式成立时 text.slice(cut + HEAD) === text.slice(-TAIL)：保留首 HEAD + 末 TAIL
    state.text = state.text.slice(0, SESSIONS.HEAD_KEEP_CHARS) + state.text.slice(cut + SESSIONS.HEAD_KEEP_CHARS);
  }
  return state;
}

/**
 * 消费式读取：从头部取走最多 cap 字符（缺省 8K）。
 * @returns {{text:string, delivered:number, remaining:number, dropped:number}}
 *   text 已含省略标记前缀（有丢弃时）与续读提示后缀（还有剩余时）；delivered 是本条正文长度。
 */
export function bufferDrain(state, cap = SESSIONS.READ_CAP_CHARS) {
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : SESSIONS.READ_CAP_CHARS;
  const dropped = state.dropped;
  const take = state.text.slice(0, limit);
  state.text = state.text.slice(take.length);
  state.dropped = 0;
  const remaining = state.text.length;
  const prefix = dropped ? `…（中间省略 ${dropped} 字未读输出）…\n` : '';
  const suffix = remaining ? `\n…（还有 ${remaining} 字未读输出，再次 write_stdin 续读）` : '';
  return { text: prefix + take + suffix, delivered: take.length, remaining, dropped };
}

// ---------- 数值夹取 ----------

/** yield_ms 归一：非数值回退 fallback；数值一律夹到 [MIN, MAX] */
export function clampYieldMs(value, fallback = SESSIONS.DEFAULT_YIELD_MS) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  return Math.min(Math.max(Math.round(base), SESSIONS.MIN_YIELD_MS), SESSIONS.MAX_YIELD_MS);
}

// ---------- 文案 ----------

function seconds(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

/** 状态徽标：exited 带退出码；killed 是显式终止 */
export function statusLabel(rec) {
  if (rec.status === 'running') return `运行中（已运行 ${seconds(Date.now() - rec.startedAt)}）`;
  if (rec.status === 'killed') return '已终止';
  return `已退出（退出码 ${rec.code == null ? '未知' : rec.code}，耗时 ${seconds(rec.exitedAt - rec.startedAt)}）`;
}

/** 找不到会话（含被回收）的统一文案 */
export function formatUnknown(id) {
  return `找不到进程 #${id}：可能已退出后被回收（会话表上限 ${SESSIONS.MAX_SESSIONS} 个）。用 list_processes 查看现有会话。`;
}

/** 后端不可用（fail-closed，绝不静默退回本地） */
export function formatBackendUnavailable(reason) {
  return `后台命令当前不可用：${reason}`;
}

/** 会话已满且全部在跑 */
export function formatAtCapacity(max) {
  return `后台命令已达上限（${max} 个且都在运行）：先用 write_stdin 处理或 kill_process 结束不再需要的进程，再启动新命令。`;
}

/** run 已被停止（abort 后新调用） */
export function formatRunAborted() {
  return '命令未执行：运行已被停止（所有后台命令已终止）';
}

/**
 * exec_command 的结果。
 * @param {{rec:object, output:string, aborted?:boolean}} p
 *   rec 至少含 id/command/status/code/startedAt/exitedAt
 */
export function formatExecStart({ rec, output, aborted = false }) {
  if (aborted) return `【进程 #${rec.id} · 已被停止】${rec.command}\n（用户停止了运行：后台命令已全部终止）`;
  const header = `【进程 #${rec.id} · ${statusLabel(rec)}】${rec.command}`;
  const body = output || '（暂无输出）';
  const footer =
    rec.status === 'running'
      ? `\n（进程仍在运行：用 write_stdin process_id=${rec.id} 继续读取输出或写入输入；结束用 kill_process）`
      : '';
  return `${header}\n${body}${footer}`;
}

/**
 * write_stdin 的结果。
 * @param {{rec:object, output:string, wrote:number, note?:string}} p
 *   rec 至少含 id/command/status/code/startedAt/exitedAt；note 为「输入未写入」等附注
 */
export function formatWriteResult({ rec, output, wrote, note = '' }) {
  const tags = [wrote > 0 ? `（已写入 ${wrote} 字符）` : '', note].filter(Boolean).join('');
  const head = `【进程 #${rec.id} · ${statusLabel(rec)}】${tags}`;
  const body = output || '（暂无新输出）';
  const footer =
    rec.status === 'running'
      ? `\n（继续用 write_stdin 轮询；进程退出前不会自动结束）`
      : '';
  return `${head}\n${body}${footer}`;
}

/** kill_process 的结果（附收尾输出） */
export function formatKillResult({ rec, output }) {
  const head = `【进程 #${rec.id} · 已终止（kill_process）】${rec.command}`;
  const body = output || '（无收尾输出）';
  return `${head}\n${body}`;
}

/** list_processes 的结果 */
export function formatList(sessions) {
  if (!sessions.length) return '（当前没有后台命令——用 exec_command 启动）';
  const lines = sessions.map(
    (s) => `- #${s.id} ${s.statusLabelText}：${s.command}（未读 ${s.unread} 字，已运行 ${seconds(s.elapsedMs)}）`,
  );
  return `后台命令（${sessions.length}/${SESSIONS.MAX_SESSIONS}）：\n${lines.join('\n')}`;
}

/** 进程列表行的状态文字（与 statusLabel 同源语义，列表里更短） */
export function listStatusText(rec) {
  if (rec.status === 'running') return '运行中';
  if (rec.status === 'killed') return '已终止';
  return `已退出(码 ${rec.code == null ? '?' : rec.code})`;
}

/** system 提示词片段：只在装配了会话工具的路径注入（run-openai），不塞进公共 prompt */
export function buildExecSessionsPrompt() {
  return [
    '',
    '## 后台命令（长任务 / 交互式命令）',
    '命令可能很久不结束（dev server、大构建、全量测试）或需要 stdin 交互时，用 exec_command 启动：最多等 yield_ms（默认 10 秒）——结束即返回输出；仍在运行则返回进程号。',
    '之后用 write_stdin 反复读取新输出或写入输入（process_id 取自返回）；不再需要时用 kill_process 结束。任务结束时所有后台命令会自动终止。快速命令仍直接用 Bash。',
  ].join('\n');
}
