/**
 * 模型流重试 + 空闲超时的**决策纯函数**（执行在 agent-loop.js）。
 *
 * 口径对齐 Codex（core/src/responses_retry.rs、model-provider-info、session/turn.rs）：
 * 指数退避、重试次数上限、流空闲判死；本项目取 2s 起步 / 60s 上限 / 5 次 / 120s 空闲
 * （来源与取舍见 docs/superpowers/specs/2026-10-11-model-stream-retry-and-idle-timeout-design.md §3）。
 *
 * 本模块零 IO：`resolveRetryOptions` 的 env 由调用方传入，单测不碰真实 process.env。
 */

export const RETRY_DEFAULTS = Object.freeze({
  maxRetries: 5, // 重试次数（不含首次尝试；Codex stream_max_retries 默认 5）
  initialDelayMs: 2_000, // 退避起步（Codex 5s；桌面单用户场景求快取 2s）
  maxDelayMs: 60_000, // 退避封顶（对齐 Codex）
  streamIdleMs: 120_000, // 流空闲判死（Codex 300s；报告 §3.4 建议 120s）
});

/** env 旋钮（e2e/自部署用；拍板：显式参数 > env > 默认） */
const ENV_KEYS = Object.freeze({
  maxRetries: 'MODEL_STREAM_RETRY_MAX',
  initialDelayMs: 'MODEL_STREAM_RETRY_BASE_MS',
  maxDelayMs: 'MODEL_STREAM_RETRY_MAX_MS',
  streamIdleMs: 'MODEL_STREAM_IDLE_MS',
});

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const nonNegative = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * 解析重试选项：显式 partial > env > 默认。非法值（NaN/负数/0 用于正数项）一律回落。
 * `maxRetries: 0` 合法 = 不重试（仅一次尝试）。
 * @param {{maxRetries?:number, initialDelayMs?:number, maxDelayMs?:number, streamIdleMs?:number}} [partial]
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveRetryOptions(partial, env = process.env) {
  const pick = (key, parse) => parse(partial?.[key]) ?? parse(env?.[ENV_KEYS[key]]) ?? RETRY_DEFAULTS[key];
  return {
    maxRetries: Math.floor(pick('maxRetries', nonNegative)),
    initialDelayMs: Math.floor(pick('initialDelayMs', positive)),
    maxDelayMs: Math.floor(pick('maxDelayMs', positive)),
    streamIdleMs: Math.floor(pick('streamIdleMs', positive)),
  };
}

/** 第 retry 次（1-based）重试前的等待：initial × 2^(retry-1)，封顶 maxDelay。 */
export function nextRetryDelayMs(retry, { initialDelayMs, maxDelayMs }) {
  const backoff = initialDelayMs * 2 ** Math.max(0, retry - 1);
  return Math.min(maxDelayMs, Math.round(backoff));
}

/**
 * 失败归类：只有明确可复活的才重试（未知错误宁可不试——重试也修不好的错误不浪费额度与等待）。
 * kind ∈ aborted / idle / finish / network / http / api / other。
 * @param {unknown} error
 * @param {{aborted?:boolean}} [ctx] 用户中断优先于一切（外层 signal.aborted）
 */
export function classifyModelError(error, { aborted = false } = {}) {
  if (aborted) return { retryable: false, kind: 'aborted' };
  const code = error && typeof error === 'object' ? error.code : undefined;
  // 自产标记错误（不依赖文案）：空闲判死 / finishReason=error
  if (code === 'stream_idle') return { retryable: true, kind: 'idle' };
  if (code === 'model_finish_error') return { retryable: true, kind: 'finish' };
  // AI SDK 的 APICallError 自带判定（408/409/429/5xx）——最权威，优先采信
  const sdkFlag = error && typeof error === 'object' ? error.isRetryable : undefined;
  if (sdkFlag === true) return { retryable: true, kind: 'api' };
  if (sdkFlag === false) return { retryable: false, kind: 'api' };
  const status = Number(error && typeof error === 'object' ? error.statusCode : NaN);
  if (Number.isFinite(status) && status > 0) {
    return { retryable: status === 408 || status === 409 || status === 429 || status >= 500, kind: 'http' };
  }
  const msg = String((error && typeof error === 'object' && error.message) || error || '');
  // 状态码藏在文案里（部分错误不带 statusCode 字段；AI SDK 的失败信息常含响应体摘要）
  if (/\b(408|409|429)\b/.test(msg)) return { retryable: true, kind: 'http' };
  if (/\b5\d\d\b/.test(msg)) return { retryable: true, kind: 'http' };
  if (/\b4\d\d\b/.test(msg)) return { retryable: false, kind: 'http' };
  // 网络断流/连接类（Node fetch/undici、SSE 半截关闭的常见措辞）
  if (
    /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|premature close|terminated|UND_ERR|network/i.test(
      msg,
    )
  ) {
    return { retryable: true, kind: 'network' };
  }
  return { retryable: false, kind: 'other' };
}

const KIND_TEXT = Object.freeze({
  idle: '流空闲超时',
  finish: '模型异常结束',
  network: '网络中断',
  http: '接口错误',
  api: '接口错误',
  aborted: '已中断',
  other: '未知错误',
});

/** 活动行用的人类可读错误类别 */
export function describeRetryKind(kind) {
  return KIND_TEXT[kind] || KIND_TEXT.other;
}

/** 活动行用的等待时长文案（「2 秒」/「500 毫秒」） */
export function formatRetryDelay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 毫秒';
  return n >= 1000 ? `${Math.round(n / 100) / 10} 秒` : `${Math.round(n)} 毫秒`;
}
