/**
 * 同事对话 agent 的 dispatch feature（P4 起走 `match` 全接）。
 *
 * P4 决策：名册内同事的消息在**意图分类之前**就归本 feature（`match`，dispatch 第 1 步）。
 * 理由有二：① 2.0 决策 #1「所有同事侧对话归 agent」——用 intents 白名单时 `action` 意图会
 * 漏给 action-runner，而那条路径已在 P4 退役；② 省掉同事消息的一次分类调用（L3 可能烧
 * 一次 Haiku）。非名册（陌生人）match 返回假，照旧走分类 → feedback。
 *
 * 本 feature **只覆盖文本**。附件在 `entrypoints/feishu/index.js` 的 image/file 分支
 * 就被接走，到不了 dispatch，那条链路直接调 `relay.js`（两边共用同一个判定）。
 */
import { PASS } from '../../app/signals.js';
import { logger } from '../../shared/logger.js';
import { getColleagues } from '../../store/colleagues.js';
import { relayToAgent, isColleagueMessage } from './relay.js';

export async function handle(ctx, _intentResult, deps = {}) {
  const { relay = relayToAgent } = deps;
  try {
    const taken = await relay({
      openId: ctx?.user?.id,
      text: ctx?.text || '',
      chatId: ctx?.sessionKey || '',
      // 回复路由（2026-10-13）：群聊 @ 出来的提问要回群里，chatType 随 payload 透传给 web。
      // meta.chatType 由飞书入口写死（M.chatType），卡片回调等非消息路径可能没有 —— 缺失时归空串，
      // 下游 resolveReplyTarget 会降级回私聊，不会静默。
      chatType: ctx?.meta?.chatType || '',
      // 「正在处理」标记的摘除凭据（2026-10-14）：agent 的答复由 web 进程发出，标记也该在那时摘
      // （见 shared/processing-mark.js）。messageId 即被贴表情的那条消息；无标记时为空串，web 侧跳过。
      feishuMessageId: ctx?.meta?.processing?.messageId || '',
      reactionId: ctx?.meta?.processing?.reactionId || '',
    });
    // 接管即移交标记：本进程不再摘，等 web 在终态答复后摘。
    // 未接管（PASS 回落 feedback）则不移交 —— 标记由入口按 hold/常规语义收尾。
    if (taken) ctx?.meta?.processing?.transfer();
    // 接管了就什么都不回：回复由 web 进程跑完 agent 后经 lark 直发。
    // 这里再回一句 ACK 的话，同事会先收到「已收到」再收到真回复，像两个机器人。
    return taken ? undefined : PASS;
  } catch (e) {
    // 异常一律 PASS 回落：让 feedback 把它当成普通反馈收走，
    // 总好过同事的消息因为一次异常彻底消失
    logger.warn('colleague-agent', 'feature 异常，交回后续 feature', { err: e?.message || String(e) });
    return PASS;
  }
}

/**
 * 是不是名册内同事的消息（纯判定，可注入名册便于单测）。
 * 与 relay.js#isColleagueMessage 同一份规则 —— 附件链路先判再决定走哪条，不得另写一份。
 */
export function matchColleague(ctx, deps = {}) {
  const { getColleagues: getList = getColleagues } = deps;
  return !!isColleagueMessage(ctx?.user?.id, getList());
}

export default {
  name: 'colleague-agent',
  permission: 'any',
  intents: [], // match 先于意图分类生效；非名册不接，交给后续 feature（feedback）
  match: (ctx) => matchColleague(ctx),
  handle,
};
