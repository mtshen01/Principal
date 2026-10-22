/**
 * 需求阶段的「进行中」判定 + 同事面板「归属需求」候选的挑选规则（纯函数，可单测）。
 *
 * 为什么单独成文件：同一份阶段口径有两处 UI 在用 —— 侧栏需求列表的活动分组（`req-view.js`）
 * 与同事面板发消息的归属下拉（`colleague-supervisor.js`）。抄两份必然漂移（加一个阶段忘一处），
 * 而阶段恰恰是最容易改坏的东西（状态机与相邻流转守卫见 `src/store/requirements.js#PHASE_FLOW`）。
 */

/** 进行中的阶段：评审 / 开发 / 测试 / 归档中。已废弃（discarded）与已归档（archived）都不算。 */
export const ACTIVE_PHASES = ['review', 'dev', 'test', 'archiving'];

/**
 * 是否算「进行中」。
 *
 * 阶段缺失（undefined / null / 空串）按**进行中**处理：宁可多给一条可选，也不要在数据有缺口时
 * 把用户的需求藏起来 —— 发送端点仍会按「该同事是否在这条需求的开发人员里」把关，
 * 多给一条最坏是选错，不会发错人。
 */
export function isActivePhase(phase) {
  if (!phase) return true;
  return ACTIVE_PHASES.includes(String(phase));
}

/**
 * 拆同事的归属候选：`active` 进下拉（可选），`archived` 只用于提示文案。
 *
 * 已归档/已废弃的需求不能再选（2026-10-16 用户口径）：那条需求的开发会话与分支都已收尾，
 * 往里发消息，同事只能回一句「这需求已经归档了」，白烧一轮。但也不能当它不存在 ——
 * 候选全是归档时要能说清「都已归档」，而不是说「没有被指派任何需求」那句假话。
 */
export function splitAssignedReqs(reqs) {
  const active = [];
  const archived = [];
  for (const r of Array.isArray(reqs) ? reqs : []) {
    if (!r || !r.id) continue;
    (isActivePhase(r.phase) ? active : archived).push(r);
  }
  return { active, archived };
}

/**
 * 重建下拉后该选中哪条：用户已选的那条还在候选里就保留，否则取候选第一条。
 *
 * 「只有一个需求时默认选中」由它兜住（唯一候选就是第一条），不必另写分支；
 * 候选为空时返回空串（此时下拉禁用，发送按钮另有禁用逻辑兜底）。
 */
export function resolveSelectedReqId(active, prevId = '') {
  const list = Array.isArray(active) ? active : [];
  if (list.some((r) => r && r.id === prevId)) return prevId;
  return list[0]?.id || '';
}
