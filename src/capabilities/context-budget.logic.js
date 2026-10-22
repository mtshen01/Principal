/**
 * 上下文预算纯函数层（P0，spec `docs/superpowers/specs/2026-10-10-context-budget-and-compaction-v2-design.md`）。
 *
 * 解决的问题：压缩触发原先只看消息条数（conv-compact 的 200 条），对「条数不多但每条很重」
 * 的会话（大工具输出/长文档/长代码）完全没有感知——窗口先爆，压缩后知后觉。本层给模型可见
 * 内容一个**廉价且确定**的 token 估算（字节 ÷ 4 启发式，对标 Codex 的 estimate_item_token_count），
 * 并给出「窗口占用是否达到压缩阈值」的统一判定。阈值判定只此一份，调用方消费布尔量，
 * 不在各处重算百分比。
 *
 * 口径（拍板）：
 *  - 文本 token ≈ UTF-8 字节 ÷ 4（向上取整；英文/代码接近真实，中文偏保守）；
 *  - 图片固定估值（与 Codex RESIZED_IMAGE_BYTES_ESTIMATE=7373 字节 ÷ 4 同源）；
 *  - 窗口未知（分母为 null）时只报 tokens、不判过线——「分母绝不猜」的既有原则；
 *  - 未知 part 类型不猜（返 0）——宁可低估，也不虚构。
 * 零 IO；触发后的编排（摘要生成/落盘/事件）在 entrypoints/web/run-openai.js。
 */
import { isImagePath } from './image-attachments.logic.js';

/** 字节 ÷ token 的启发式系数（与 Codex 口径一致） */
export const BYTES_PER_TOKEN = 4;
/** 图片固定估值（tokens）：来源同 Codex（7373 字节 ÷ 4 ≈ 1844） */
export const IMAGE_TOKEN_ESTIMATE = 1844;
/** 自动压缩阈值：估算 token 占窗口达到该比例即触发（与 Codex 缺省 90% 一致） */
export const AUTO_COMPACT_RATIO = 0.9;

/** 文本 → token 估算（UTF-8 字节 ÷ 4，向上取整；非字符串/空串→0） */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

/** 任意 JSON 值 → token 估算（对象走序列化；字符串直接测；序列化失败不猜） */
export function estimateJsonTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * 消息 part → token 估算（AI SDK ModelMessage 的 part 形态）。
 * 覆盖本项目实际用到的：text / reasoning / image / tool-call / tool-result；
 * 其余类型（未来 SDK 扩展）一律 0——宁可低估也不虚构。
 */
export function estimatePartTokens(part) {
  if (!part || typeof part !== 'object') return 0;
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return estimateTextTokens(part.text);
    case 'image':
      // base64/URL 都不数原文——统一按固定估值（防一张图把估算炸上天）
      return IMAGE_TOKEN_ESTIMATE;
    case 'tool-call':
      return estimateTextTokens(part.toolName) + estimateJsonTokens(part.input);
    case 'tool-result':
      return estimateJsonTokens(part.output);
    default:
      return 0;
  }
}

/** 单条消息 → token 估算（content 为字符串或 part 数组；含图片附件元数据的固定估值） */
export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  const c = message.content;
  let sum = 0;
  if (typeof c === 'string') sum = estimateTextTokens(c);
  else if (Array.isArray(c)) {
    for (const part of c) sum += estimatePartTokens(part);
  }
  // 图片附件（attachments 元数据；内联发生在模型边界，见 image-attachments.logic.js）：
  // 一张图按固定估值计。类型只按扩展名认（真正判定走魔数、发生在发送面）——估算宁可保守。
  if (Array.isArray(message.attachments)) {
    for (const a of message.attachments) if (a && isImagePath(a.path)) sum += IMAGE_TOKEN_ESTIMATE;
  }
  return sum;
}

/** 消息数组 → token 估算（顺序无影响，逐条累计） */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let sum = 0;
  for (const m of messages) sum += estimateMessageTokens(m);
  return sum;
}

/**
 * 上下文窗口状态（唯一的阈值判定点）：
 *  - tokens：模型可见内容估算（view 消息 + 摘要文本 + 额外预留）；
 *  - window / limit：窗口与 90% 阈值；窗口未知时为 null；
 *  - over：是否达到/超过阈值（窗口未知时恒 false——分母不猜）；
 *  - usageRatio：tokens / window（窗口未知时 null；只报数，不算百分比）。
 *
 * @param {{messages?:Array, summaryText?:string, extraTokens?:number, windowTokens?:number|null, ratio?:number}} p
 */
export function contextTokenStatus({
  messages = [],
  summaryText = '',
  extraTokens = 0,
  windowTokens = null,
  ratio = AUTO_COMPACT_RATIO,
} = {}) {
  const extra = Math.max(0, Math.floor(Number(extraTokens) || 0));
  const tokens = estimateMessagesTokens(messages) + estimateTextTokens(summaryText) + extra;
  const win = Math.floor(Number(windowTokens));
  const window = Number.isFinite(win) && win > 0 ? win : null;
  const limit = window ? Math.max(1, Math.floor(window * ratio)) : null;
  return {
    tokens,
    window,
    limit,
    usageRatio: window ? tokens / window : null,
    over: limit != null && tokens >= limit,
  };
}
