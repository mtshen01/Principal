import { estimateMessageTokens } from '../../capabilities/context-budget.logic.js';
import { clipMiddle } from '../../capabilities/context-normalize.logic.js';

/**
 * 上下文压缩纯函数层（T7，spec `docs/superpowers/specs/2026-10-08-context-compaction-design.md`；
 * P0 双触发升级：spec `docs/superpowers/specs/2026-10-10-context-budget-and-compaction-v2-design.md`）。
 *
 * 解决的问题：`conv-messages` 原先在追加时硬截 200 条，切点不看角色——tool 序列被拦腰切开时
 * 保留段头部会留「没有对应 tool-call 的 tool 结果」，可能直接 400；且旧消息被物理丢弃。
 * 本层提供边界安全的切点选择 + 摘要输入/输出的格式化；运行时编排（LLM 调用、落盘）在 run-openai.js。
 * 消息序列不变量（悬空修复/孤立清理/剪空/单条中间截断）与 `clipMiddle` 已随 P0-③ 收口到
 * `capabilities/context-normalize.logic.js`（发送前必过），本层只保留摘要专门逻辑。
 *
 * 口径（拍板）：
 *  - 触发双口径：模型可见条数 > COMPACT_TRIGGER，或估算 token 达窗口 90%（阈值判定收在
 *    `capabilities/context-budget.logic.js#contextTokenStatus`，本层只消费布尔量）；
 *  - 保留段：最近 ≥ COMPACT_KEEP_RECENT 条；若这截尾部的估算 token 超 COMPACT_KEEP_TOKEN_BUDGET，
 *    则收缩保留窗口（不低于 COMPACT_KEEP_MIN 条），沿 user 边界取整轮；
 *  - 新丢 ≥ COMPACT_MIN_DROP 才动手。零 IO。
 */

/** 触发阈值：模型可见消息条数超过它才考虑压缩（与旧 200 上限同量级） */
export const COMPACT_TRIGGER = 200;
/** 压缩后至少保留的近期消息条数（实际取 ≥ 它的最近 user 边界） */
export const COMPACT_KEEP_RECENT = 100;
/** 保留段估算 token 预算：尾部消息超它就收缩保留窗口（token 触发时防「压缩完仍然超」） */
export const COMPACT_KEEP_TOKEN_BUDGET = 20_000;
/** 保留窗口收缩下限（条）：再重的会话也至少留这么多条近期消息 */
export const COMPACT_KEEP_MIN = 20;
/** 新增可丢条数下限：太少就攒着，避免每轮都调一次摘要 */
export const COMPACT_MIN_DROP = 20;
/** 摘要文本上限（防止摘要自身撑爆 system） */
export const MAX_SUMMARY_CHARS = 2000;
/** 送进摘要调用的转录总预算（头尾截断） */
export const SUMMARY_INPUT_BUDGET_CHARS = 60_000;
/** 转录里单条消息的展示上限 */
const PER_MESSAGE_CHARS = 1500;

/**
 * 是否要压缩：模型可见长度（总条数 − 摘要已覆盖条数）超过阈值。
 * @param {{total:number, covered?:number}} p
 */
export function shouldCompact({ total, covered = 0 } = {}) {
  const t = Number(total) || 0;
  const c = Math.max(0, Number(covered) || 0);
  return t - c > COMPACT_TRIGGER;
}

/**
 * 计算实际保留条数（token 感知，P0）：从尾部向前累计，最多 maxKeep 条；
 * 累计估算 token 超过 tokenBudget 即停（保留越过预算的那条，宁可多留不可少留），
 * 但不低于 minKeep 条——近期上下文优先于预算。
 *
 * 动机：条数不多但每条很重（大工具输出/长文档）时，固定保留 100 条会让「压缩完
 * 模型视角仍然超窗」。收缩保留窗口后，更早的重消息进入摘要、模型视角立即可控。
 * @param {Array} messages 完整历史（含已覆盖段；本函数只看尾部）
 * @returns {number} 保留条数（≥1；实际切点还会沿 user 边界取整轮，见 pickCompactCut）
 */
export function resolveKeepRecent(
  messages,
  { maxKeep = COMPACT_KEEP_RECENT, tokenBudget = COMPACT_KEEP_TOKEN_BUDGET, minKeep = COMPACT_KEEP_MIN } = {},
) {
  const list = Array.isArray(messages) ? messages : [];
  const max = Math.max(1, Math.floor(Number(maxKeep) || COMPACT_KEEP_RECENT));
  const min = Math.min(max, Math.max(1, Math.floor(Number(minKeep) || COMPACT_KEEP_MIN)));
  const budget = Number.isFinite(Number(tokenBudget)) && Number(tokenBudget) > 0 ? Number(tokenBudget) : Infinity;
  let kept = 0;
  let tokens = 0;
  for (let i = list.length - 1; i >= 0 && kept < max; i--) {
    tokens += estimateMessageTokens(list[i]);
    kept++;
    if (kept >= min && tokens > budget) break;
  }
  return Math.max(1, Math.min(max, kept));
}

/**
 * 选压缩切点：保留段从该索引开始（旧段被摘要替代）。
 * 约束：`cut ≤ len - keepRecent`；且 `messages[cut].role === 'user'`（整轮边界，天然不切 tool 序列）；
 * 且新丢条数（cut − covered）≥ minDrop。
 * @returns {number} 切点索引；无法安全压缩时返回 -1
 */
export function pickCompactCut(messages, { keepRecent = COMPACT_KEEP_RECENT, minDrop = COMPACT_MIN_DROP, covered = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxCut = list.length - Math.max(1, Number(keepRecent) || 0);
  if (maxCut <= 0) return -1;
  let i = maxCut;
  while (i > 0 && list[i]?.role !== 'user') i--;
  if (i <= 0) return -1; // 找不到整轮边界（或会切到第 0 条）→ 本轮不压
  const c = Math.max(0, Number(covered) || 0);
  if (i < c + Math.max(1, Number(minDrop) || 0)) return -1; // 新增可丢太少 → 攒着
  return i;
}

/** 单条消息 → 摘要输入用的可读文本（text/tool-call/tool-result/reasoning 全形态） */
function messageToText(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const out = [];
  for (const p of c) {
    if (!p) continue;
    if (p.type === 'text' && p.text) out.push(String(p.text));
    else if (p.type === 'reasoning' && p.text) out.push(`[推理] ${p.text}`);
    else if (p.type === 'tool-call') out.push(`[调用 ${p.toolName || '?'}] ${safeJson(p.input)}`);
    else if (p.type === 'tool-result') out.push(`[结果] ${toolOutputText(p.output)}`);
  }
  return out.join(' ').trim();
}

function safeJson(v) {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return '(无法序列化)';
  }
}

/** tool result 的 output 形状不定（{type:'text',value} / {type:'error-text',value} / 字符串 / 对象） */
function toolOutputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'value' in output) return typeof output.value === 'string' ? output.value : safeJson(output.value);
  return safeJson(output);
}

const ROLE_LABEL = { user: '用户', assistant: '助手', tool: '工具结果', system: '系统' };

/**
 * 被丢段 → 紧凑转录（送进摘要调用的输入）。
 * 单条先截断再拼，整体再做头尾截断——摘要调用花的也是会话自己的额度。
 */
export function formatMessagesForSummary(messages, { budgetChars = SUMMARY_INPUT_BUDGET_CHARS, perMessageChars = PER_MESSAGE_CHARS } = {}) {
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = messageToText(m);
    if (!text) continue;
    parts.push(`【${ROLE_LABEL[m?.role] || m?.role || '?'}】${clipMiddle(text, perMessageChars)}`);
  }
  return clipMiddle(parts.join('\n'), budgetChars);
}

/** 摘要四要素小节（P0 对齐 Codex；system prompt 与 user prompt 共用同一常量，防两处漂移） */
export const SUMMARY_SECTIONS = ['【进度与决策】', '【约束与偏好】', '【待办与下一步】', '【关键数据】'];

/** 摘要系统提示：固定四要素小节（进度/约束/待办/数据），某节无内容也要保留标题，不编造 */
export const SUMMARY_SYSTEM_PROMPT =
  '你是会话压缩器。把给定的对话历史压缩成一份供同一位助手继续工作用的要点备忘。' +
  '必须按四个小节输出，某节没有内容也要保留小节标题：' +
  '【进度与决策】已完成的工作与关键决定；' +
  '【约束与偏好】用户的目标、约束与偏好；' +
  '【待办与下一步】未完成事项与下一步动作；' +
  '【关键数据】命令/路径/ID/报错原文等继续工作必须核实的事实。' +
  '丢弃：寒暄、重复、已被后续修正的中间方案。绝不编造未出现的信息。只输出要点文本，不要寒暄。';

/**
 * 滚动摘要 prompt：旧摘要 + 新增被丢段 → 输出更新后的单一摘要。
 * @param {{previousSummary?:string, droppedText?:string}} p
 */
export function buildSummaryPrompt({ previousSummary = '', droppedText = '' } = {}) {
  const prev = String(previousSummary || '').trim();
  const dropped = String(droppedText || '').trim();
  return [
    prev ? `【已有摘要（覆盖更早的对话）】\n${clipMiddle(prev, MAX_SUMMARY_CHARS)}` : '',
    dropped ? `【新增需要并入摘要的对话】\n${dropped}` : '',
    `请输出更新后的单一摘要，固定四个小节：${SUMMARY_SECTIONS.join('')}（纯文本要点，总字数控制在 800 字以内）。`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 摘要文本归一：trim + 截断 */
export function normalizeSummaryText(text, max = MAX_SUMMARY_CHARS) {
  return clipMiddle(String(text ?? '').trim(), max);
}

/** 视图 system：主提示词 + 摘要段（不造假的 user/assistant 轮） */
export function composeSystemWithSummary(systemPrompt, summaryText) {
  const s = normalizeSummaryText(summaryText);
  if (!s) return systemPrompt;
  return `${systemPrompt}\n\n## 历史摘要（较早对话的自动摘要；原文已保留在系统中，需要细节时可要求核对原文）\n${s}`;
}
