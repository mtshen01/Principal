/**
 * 排队卡片条纯逻辑（无 DOM）：本地卡片 × 服务端清单的合并与「已投递」判定。
 *
 * 背景：queue-first（2026-10-16）下运行中发送的消息不再进转录流，而是排在服务端；
 * 前端卡片状态必须以 /api/run/queue 为准。本地（含 conv.meta.queue 持久化恢复）只做
 * 文本缓存与「离线期间已完成投递」的发现。
 */

/**
 * 合并本地卡片与服务端清单。
 *
 * - 以服务端顺序/字段重建 items；文本优先服务端，服务端缺文本时回落本地缓存。
 * - 本地有、服务端无 → 视为已投递（被「立即发送」消费 / 排空起新轮 / 关页期间完成）。
 *   仅判「早于本次拉取发起」的项：拉取发起后才加入的卡片可能撞上更早发出的陈旧响应，
 *   不能误判为上屏（否则刚排队的新消息会被提前插进转录流）。
 *
 * @param {Array<{id:string,text:string,at?:number}>} localItems 本窗卡片（可能含持久化恢复的旧项）
 * @param {Array<{id:string,text?:string,mode?:string,at?:number}>} serverItems 服务端清单（唯一真相）
 * @param {{fetchStartedAt?:number}} [opts] 本次拉取的发起时刻（客户端时钟）
 * @returns {{items:Array<{id:string,text:string,mode:'queue'|'steer',at:number}>, delivered:Array}}
 */
export function mergeQueue(localItems, serverItems, { fetchStartedAt = 0 } = {}) {
  const localList = Array.isArray(localItems) ? localItems : [];
  const serverList = Array.isArray(serverItems) ? serverItems : [];
  const localById = new Map(localList.filter((m) => m && m.id).map((m) => [m.id, m]));
  const items = serverList
    .filter((s) => s && s.id)
    .map((s) => {
      const l = localById.get(s.id);
      return {
        id: s.id,
        text: typeof s.text === 'string' && s.text ? s.text : (l && l.text) || '',
        mode: s.mode === 'steer' ? 'steer' : 'queue',
        at: (l && l.at) || s.at || 0,
      };
    });
  const serverIds = new Set(items.map((m) => m.id));
  const delivered = localList.filter(
    (m) => m && m.id && !serverIds.has(m.id) && (m.at || 0) < fetchStartedAt,
  );
  return { items, delivered };
}
