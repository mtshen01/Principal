/**
 * 飞书「问同事」询问卡的按钮回调（`kind='feishu-ask-answer'`）。
 *
 * 同事点选项 → 跨进程回流 **web 进程**的 feishu-ask 引擎（`/api/req/feishu-ask/answer`），
 * 当作一次回答喂进判定闭环（与同事打字回复同一套追问/结算逻辑）。
 *
 * 只被飞书入口 import：web 进程不需要（也不该）挂这个处理器。超时 3s + **不重试**，
 * 与 `colleague-agent/relay.js#realPostToWeb` 同范式——点选是「喂一条回答」，重试反而会在
 * 判定串行队列里制造重复。判定引擎内层已兜异常，因此不复查响应体。
 */
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { registerCardKindHandler } from '../shared/card-actions.js';

/** 飞书卡片按钮 value.kind 取值（唯一真相源；出卡侧在 feishu-ask.logic.js 引用同一字面量） */
export const FEISHU_ASK_CARD_KIND = 'feishu-ask-answer';

const TIMEOUT_MS = 3000;

/**
 * 解析卡片回调 data 里的按钮 value（纯函数，便于单测）。
 * @returns {{questionId:string, option:string}|null}
 */
export function parseAskCardValue(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== FEISHU_ASK_CARD_KIND) return null;
  const questionId = String(value.questionId || '').trim();
  const option = String(value.option || '').trim();
  if (!questionId || !option) return null;
  return { questionId, option };
}

/** 默认回流实现：跨进程直送 web（fire-and-forget） */
async function postToWeb({ questionId, option }) {
  const url = `http://127.0.0.1:${config.web.port}/api/req/feishu-ask/answer`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, option }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status !== 202 && r.status !== 200) {
      const data = await r.json().catch(() => ({}));
      logger.warn('feishu', '问同事选项未被受理', { questionId, status: r.status, error: data.error });
    }
  } catch (e) {
    logger.warn('feishu', '问同事选项回流失败（已忽略）', { questionId, err: e?.message || String(e) });
  }
}

/** 造处理器（post 可注入便于单测；默认跨进程直送 web） */
export function buildAskOptionHandler(post = postToWeb) {
  return async (data) => {
    const parsed = parseAskCardValue(data);
    if (!parsed) {
      logger.warn('feishu', '问同事卡片回调参数不完整（已忽略）', { value: data?.action?.value ?? null });
      return;
    }
    await post(parsed);
  };
}

// 模块加载即注册（只在飞书入口被 import）
registerCardKindHandler(FEISHU_ASK_CARD_KIND, buildAskOptionHandler());
