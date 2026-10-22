/**
 * web 入口 openai run 编排的纯函数层（无 I/O，可单测）。
 * run-openai.js 本体全是 SDK/网络/落盘，无法直测，判定与修复逻辑收在这里。
 * 孤儿对账归类（原 classifyOpenAiOrphan）已随 P5 统一迁至 `run-reconcile.logic.js#classifyInterrupted`；
 * 悬空工具调用修复（原 repairDanglingToolCalls）已随 P0-③ 泛化为发送前不变量集，
 * 见 `capabilities/context-normalize.logic.js#normalizeForModel`（run-openai.js 的载入/发送两处调用）。
 */

/**
 * 工具循环步数上限归一（composer/基础设置的 `uiPrefs.openaiMaxSteps`）。
 * 正整数 → 该值（取整）；**0 / 空 / 非法 → Infinity（无上限）**——对齐 Claude Code / OpenCode
 * 的默认口径（spec `2026-10-08-unlimited-steps-and-forced-wrapup.md`）。
 */
export function resolveMaxSteps(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}
