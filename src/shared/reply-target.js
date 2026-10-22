/**
 * 回复目标路由（纯函数）—— 同事对话的两条发送路径（飞书进程 relay / web 进程 agent）
 * 共用同一份判定，不得各写一份。
 *
 * 规则：**谁在哪问，就回哪**。
 * - 群聊里 @ 出来的提问 → 回群里，@ 提问人（2026-10-13 拍板：此前固定回私聊，
 *   群里其他人看不到答复，像机器人没理人；提问人也要从群里的 @ 得到通知）；
 * - 私聊里的提问 → 回私聊（原行为不变）。
 *
 * chatType 缺失/非 'group' 或 chatId 为空时一律降级回私聊：
 * 拿不到群坐标就把答复发进那个群是不可能的，但**绝不静默**——宁可回私聊，
 * 也不能让同事等一个永远不来的回复（failure 语义与 channels 的降级口径一致）。
 *
 * 返回的 `at` 是拼好的 `<at user_id="ou_xxx"></at> ` 前缀（仅群聊非空），
 * 由发送侧原样拼在正文前面；私聊为空串，不能把 `<at>` 标签发进 p2p（会渲染成怪串）。
 */
import { atPrefix } from './mention.js';

/**
 * @param {{ openId?: string, chatId?: string, chatType?: string|null }} p
 *   openId   提问人（回复对象 / 群聊 @ 的人）
 *   chatId   消息来源会话 id（群聊时即群 id）
 *   chatType 'group' | 'p2p' | null
 * @returns {{ kind: 'group'|'p2p', receiveId: string, at: string }}
 *   kind='group' 时 receiveId 是 chat_id、at 非空；kind='p2p' 时 receiveId 是 open_id、at 为空串
 */
export function resolveReplyTarget({ openId, chatId, chatType } = {}) {
  const id = typeof openId === 'string' ? openId : '';
  const cid = typeof chatId === 'string' ? chatId : '';
  if (chatType === 'group' && cid) {
    return { kind: 'group', receiveId: cid, at: atPrefix(id, 'group') };
  }
  return { kind: 'p2p', receiveId: id, at: '' };
}
