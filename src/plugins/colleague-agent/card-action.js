/**
 * 「撤销卡片」（agent-undo）的按钮回调 —— 注册在 **feishu 进程**（卡片事件只到这里）。
 *
 * 撤销本身在 web 进程执行（git revert / store 写都在那边，P4 的 `POST /api/req/agent-action/undo`）。
 * 本模块只做三件事：**解析 → 权限闸 → 跨进程 POST + updateCard 回执**。
 *
 * 权限与任务卡片同口径（`canOperateRelay`：本人 / owner 白名单 / 可信提交人）——
 * 撤销是主机级操作，名册里的普通同事点不动。
 *
 * 超时 30s：撤销可能真的跑 git revert，relay 那档 3s 不够；**不重试**——失败把结果写回卡片，
 * 用户可再点一次（撤销幂等：撤过的会回「已经撤销过了」）。
 * 卡片按钮 value 自带 actionId，无内存态：机器人重启后旧卡片照样能撤。
 */
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { parseAgentUndoCardAction, buildAgentUndoResultCard, AGENT_UNDO_CARD_KIND } from '../../shared/agent-undo-card.js';
import { updateCard } from '../../integrations/lark.js';
import { canOperateRelay, resolveTrustedOpenIds } from '../../shared/trusted-ids.js';
import { config } from '../../shared/config.js';
import { getMyFeishuOpenId } from '../../store/settings.js';
import { logger } from '../../shared/logger.js';

export const UNDO_TIMEOUT_MS = 30_000;

/** 跨进程撤销（fetch 可注入，单测不碰网络）。web 侧 409 带 error 原文，原样带回给卡片。 */
async function postUndo(actionId, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const url = `http://127.0.0.1:${config.web.port}/api/req/agent-action/undo`;
  const r = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: actionId }),
    signal: AbortSignal.timeout(UNDO_TIMEOUT_MS),
  });
  const data = await r.json().catch(() => ({}));
  return {
    ok: r.ok === true && data?.ok === true,
    error: data?.error || (r.ok ? '' : `HTTP ${r.status}`),
    note: data?.note || null,
  };
}

/**
 * 卡片回调入口。**永不抛**（卡片分发层不应收到本模块的异常）。
 * @param {object} data 卡片回调原始报文
 * @param {object} [deps] 注入便于单测：updateCard / postUndo / permOpts / fetch
 */
export async function handleAgentUndoCard(data, deps = {}) {
  const {
    updateCard: updateCardFn = updateCard,
    postUndo: postUndoFn = null,
    permOpts = () => ({
      myOpenId: getMyFeishuOpenId(),
      ownerOpenIds: config.lark.ownerOpenIds,
      trustedOpenIds: resolveTrustedOpenIds(getMyFeishuOpenId()),
    }),
  } = deps;

  const parsed = parseAgentUndoCardAction(data);
  if (!parsed) return; // 非本 kind：不是给我们的事件，静默

  const safeUpdate = async (result) => {
    if (!parsed.messageId) return;
    try {
      await updateCardFn(parsed.messageId, buildAgentUndoResultCard(result));
    } catch (e) {
      logger.warn('colleague-agent', '撤销结果卡片更新失败（已捕获）', { err: e?.message || String(e) });
    }
  };

  // 权限闸：与 task-notify 的任务卡片同一把尺子；无权既不撤销也不静默——把结果写回卡片
  if (!canOperateRelay(parsed.operatorOpenId, permOpts())) {
    logger.info('colleague-agent', '撤销卡片被非授权用户点击', { operator: parsed.operatorOpenId });
    await safeUpdate({ ok: false, error: '仅主机/可信提交人可执行撤销' });
    return;
  }

  try {
    const result = await (postUndoFn ? postUndoFn(parsed.actionId) : postUndo(parsed.actionId, deps));
    await safeUpdate(result);
    logger.info('colleague-agent', '撤销卡片回调完成', { actionId: parsed.actionId, ok: result.ok });
  } catch (e) {
    // 网络抖动/后端未起：把失败写回卡片（不重试；用户可再点，撤销天然幂等）
    logger.warn('colleague-agent', '撤销请求失败（已捕获）', { actionId: parsed.actionId, err: e?.message || String(e) });
    await safeUpdate({ ok: false, error: `连接后端失败：${e?.message || String(e)}` });
  }
}

// 自注册（与其余卡片 kind 一致：插件加载时生效，停用即不存在）
registerCardKindHandler(AGENT_UNDO_CARD_KIND, handleAgentUndoCard);
