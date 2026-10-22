/**
 * 顶栏「上下文使用率」纯逻辑（自定义模型路径）—— 零 DOM，供 context-progress.js / chat.js 调用、node --test 直测。
 *
 * 数据链：openai 路径**每个模型步**上报一次用量（`agent-loop` 的 `onUsage` → `runs.js#runUsage`
 * → SSE `usage`），其中 `inputTokens` 是**本步发出去的 prompt 大小**，也就是当前上下文占用；
 * 分母是该模型 `/models` 元数据里的 `context_window`（`provider-models.logic.js` 解析）。
 *
 * 关键取舍：**窗口未知时不算百分比**。分母猜错比没有更坏——用户会拿这个百分比决定
 * 「要不要新开会话/等自动压缩」，一个假的分母会让他做出错误判断。所以那种情况下只报 tokens。
 */

export const CTX_WARN_PERCENT = 70;
export const CTX_DANGER_PERCENT = 90;

/** 人类可读的 token 数：1234 → 1.2k、12345 → 12k、1234567 → 1.2M（顶栏空间紧，不留多余小数位） */
export function formatTokens(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 1000) return String(v);
  if (v < 10000) return (v / 1000).toFixed(1) + 'k';
  if (v < 1000000) return Math.round(v / 1000) + 'k';
  return (v / 1000000).toFixed(1) + 'M';
}

/** 占用率分档：<70 正常、70~89 警告、≥90 危险（与额度圆点同一套颜色语义） */
export function contextLevel(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return 'normal';
  if (p >= CTX_DANGER_PERCENT) return 'danger';
  if (p >= CTX_WARN_PERCENT) return 'warning';
  return 'normal';
}

/**
 * 组装顶栏渲染所需的一切（chip 文案 / 分档 / tooltip 行）。
 * @param {{inputTokens?:number, outputTokens?:number, contextWindow?:number, model?:string, at?:number}} p
 * @returns {{hidden:boolean, used:number, window:number, percent:number|null, level:string,
 *            label:string, lines:string[]}}
 */
export function contextUsageView({ inputTokens, outputTokens, contextWindow } = {}) {
  const used = Math.max(0, Math.floor(Number(inputTokens) || 0));
  const out = Math.max(0, Math.floor(Number(outputTokens) || 0));
  const win = Math.max(0, Math.floor(Number(contextWindow) || 0));
  const percent = win > 0 ? Math.round((used / win) * 100) : null;
  // 一点数据都没有（新会话 / Claude 会话）：整块不显示，别在顶栏留一个空的「上下文 0」
  if (used <= 0) return { hidden: true, used: 0, window: win, percent, level: 'normal', label: '', lines: [] };

  const level = contextLevel(percent);
  const label = percent == null ? `上下文 ${formatTokens(used)}` : `上下文 ${percent}%`;
  const lines = [
    percent == null
      ? `已用 ${formatTokens(used)} tokens（该模型未提供上下文窗口，只能报用量）`
      : `已用 ${formatTokens(used)} / ${formatTokens(win)} tokens`,
  ];
  if (out > 0) lines.push(`最近一步输出 ${formatTokens(out)} tokens`);
  if (percent != null) {
    if (percent >= 100) lines.push('已超出窗口：请新开对话（或让服务商侧扩窗）后继续');
    else if (level === 'danger') lines.push('即将占满：建议新开对话，长会话会被自动压缩，摘要可能丢细节');
    else if (level === 'warning') lines.push(`已用较多，剩余约 ${formatTokens(win - used)} tokens`);
    else lines.push(`剩余约 ${formatTokens(win - used)} tokens`);
  }
  return { hidden: false, used, window: win, percent, level, label, lines };
}
