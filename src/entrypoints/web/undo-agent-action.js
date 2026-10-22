/**
 * 「乐观执行 + 可撤销」授权模型的兑现处：主机点一次撤销，把台账里的锚点变回真实操作。
 *
 * 上游写台账的两处（`capabilities/agent-tools.js#recordLedger` 即时写 + `colleague-dev.js`
 * 收尾写 start_dev_task）+ P4 各工具 `buildUndo` 已经把「怎么撤」编码进 `undo.kind`；
 * 这里只负责按 kind 分派、以及一条贯穿全程的铁律：**只有撤销真正成功才 markUndone**。
 * 标早了等于把「改动其实还在」永久藏起来——主机再也点不了那个按钮，问题却没解决。
 *
 * ## 六种 kind（P4 起）
 *
 * - `revert-merge` / `delete-apidoc`：P2 既有（git revert 或删分支 / 删接口文档登记）。
 * - `revert-req-change`：摘 `req.changes` 那条 + 撤下排队中的同 changeId 地图更新。
 * - `remove-supplement`：摘 `req.supplements` 那条 + 从排队 docgen 里摘掉本补充；
 *   文档若已按它出过新版，撤销仍成立但回执如实说明（下游效果不自动回滚）。
 * - `discard-task`：任务状态机——未开始 → 置 rejected；开发中 → 拒绝并提示；完成 → 落盘侧放弃。
 * - `remove-figma`：地图页 figmas 过滤该条后覆盖写版本。
 *
 * 队列类撤销**只动尚未出队的任务**（判据见 requirement-ops#cancelQueuedTask 注释）；
 * 已派发的下游效果不回滚，但回执必须逐项说明 —— 不藏事是这套模型的底线。
 */
import { getAction, markUndone } from '../../store/agent-actions.js';
import { getRequirement, updateRequirement } from '../../store/requirements.js';
import { getTask, updateTask } from '../../store/tasks.js';
import { revertMergeCommit } from '../../plugins/team-tools/auto-dev/revert.js';
import { deleteBranch } from '../../plugins/team-tools/auto-dev/git.js';
import { discardTaskById } from '../../plugins/team-tools/task-actions.js';
import {
  cancelQueuedTask,
  removeQueuedSupplement,
  readMapVersion,
  writeMapVersion,
} from './requirement-ops.js';
import { mergeFigmas } from './req-map.logic.js';

/**
 * 撤销一份接口文档登记（`register_api_doc` 的撤销侧）。
 * 按 `name` 而非 `id` 定位——`registerApiDoc` 本就以 name 去重（见 requirement-ops.js），
 * 撤销锚点在工具调用那一刻只知道 name，不该也不需要多存一份 id。
 */
function deleteApiDoc(reqId, name) {
  const req = getRequirement(reqId);
  if (!req) return { ok: false, error: '需求不存在，接口文档撤销不了' };
  const apiDocs = req.apiDocs || [];
  const doc = apiDocs.find((d) => d.name === name);
  if (!doc) return { ok: false, error: `接口文档已不存在：${name}` };
  const next = apiDocs.filter((d) => d.name !== name);
  updateRequirement(reqId, { apiDocs: next }, `撤销登记：删除接口文档 ${name}`);
  return { ok: true };
}

/** 撤销需求变动：摘记录 + 撤下排队中的地图更新（已更新过的地图不回退，回执说明） */
export function revertReqChange(reqId, changeId, deps = {}) {
  const { getReq = getRequirement, updateReq = updateRequirement, cancelQueued = cancelQueuedTask } = deps;
  const req = getReq(reqId);
  if (!req) return { ok: false, error: '需求不存在，变动撤不了' };
  const changes = req.changes || [];
  const hit = changes.find((c) => c.id === changeId);
  if (!hit) return { ok: false, error: '这条变动已经不在需求上了' };
  updateReq(
    reqId,
    { changes: changes.filter((c) => c.id !== changeId) },
    `撤销需求变动：${String(hit.text || '').slice(0, 30)}`,
  );
  const dropped = cancelQueued(reqId, 'mapchange', (p) => p?.changeId === changeId);
  return { ok: true, note: dropped ? '已连同排队中的地图更新一起撤销' : '地图若已更新过，内容不回退' };
}

/** 撤销补充说明：摘记录 + 从排队 docgen 摘掉本补充（消费过/排队中分别在回执说明） */
export function removeSupplement(reqId, supplementId, deps = {}) {
  const { getReq = getRequirement, updateReq = updateRequirement, removeQueued = removeQueuedSupplement } = deps;
  const req = getReq(reqId);
  if (!req) return { ok: false, error: '需求不存在，补充说明撤不了' };
  const supplements = req.supplements || [];
  const hit = supplements.find((s) => s.id === supplementId);
  if (!hit) return { ok: false, error: '这条补充说明已经不在需求上了' };
  updateReq(
    reqId,
    { supplements: supplements.filter((s) => s.id !== supplementId) },
    '撤销补充说明',
  );

  const dropped = removeQueued(reqId, supplementId);
  const consumed = (req.devDoc?.versions || []).some(
    (v) => v?.at && hit.at && Date.parse(v.at) > Date.parse(hit.at),
  );
  let note = '';
  if (dropped) note = '已连同排队中的文档修订一起撤销';
  if (consumed) note = (note ? note + '；' : '') + '开发文档已按它出过新版，如需还原请另发一条修正';
  return { ok: true, note };
}

/** 放弃一条任务（report_bug 的撤销侧）：未开始置 rejected；开发中拒绝；完成走落盘侧放弃 */
export async function discardTask(taskId, deps = {}) {
  const { getTaskFn = getTask, updateTaskFn = updateTask, discardById = discardTaskById } = deps;
  const task = getTaskFn(taskId);
  if (!task) return { ok: false, error: '任务不存在，放弃不了' };
  if (task.discarded) return { ok: false, error: '这条任务已经放弃过了' };

  if (task.status === 'done') {
    const r = await discardById(taskId);
    if (!r?.ok) return { ok: false, error: r?.error || '放弃失败' };
    return { ok: true, note: r.task?.merged ? '已撤销已合并的改动' : '已删除任务分支' };
  }
  if (task.status === 'developing') {
    return { ok: false, error: '任务正在开发中，等它跑完再放弃' };
  }
  const t = updateTaskFn(
    taskId,
    { status: 'rejected', rejectedBy: 'owner', discarded: true, discardedAt: new Date().toISOString() },
    '撤销同事对话提交的故障',
  );
  return t ? { ok: true, note: '任务已取消（还没开始开发）' } : { ok: false, error: '任务状态更新失败' };
}

/** 撤销设计稿引用：地图页过滤该条后覆盖写版本 */
export function removeFigma(reqId, pageId, figmaId, deps = {}) {
  const {
    getReq = getRequirement,
    updateReq = updateRequirement,
    readMap = readMapVersion,
    writeMap = writeMapVersion,
    merge = mergeFigmas,
  } = deps;
  const req = getReq(reqId);
  if (!req) return { ok: false, error: '需求不存在' };
  const map = readMap(req);
  if (!map) return { ok: false, error: '需求地图不存在' };
  const page = (map.pages || []).find((p) => p.id === pageId);
  if (!page) return { ok: false, error: '设计稿所在的页面不在了' };
  const before = Array.isArray(page.figmas) ? page.figmas : [];
  if (!before.some((f) => f.id === figmaId)) return { ok: false, error: '这张设计稿已经不在页面上了' };
  try {
    page.figmas = merge(before, before.filter((f) => f.id !== figmaId));
    writeMap(req, map);
  } catch (e) {
    return { ok: false, error: '地图写入失败：' + (e?.message || String(e)).slice(0, 120) };
  }
  updateReq(reqId, {}, `撤销设计稿引用：${page.name}`);
  return { ok: true, note: '设计稿引用已移除' };
}

/**
 * 按 `undo.kind` 分派到具体的撤销执行。**永不抛**——调用方（HTTP handler）不必再包一层
 * try/catch，一律读 `{ok, error, note}` 判断。
 * @param {string} id agent-actions 台账条目 id
 * @param {object} [deps] 测试注入点（各撤销执行函数的替身）
 * @returns {Promise<{ok:boolean, error?:string, note?:string}>}
 */
export async function undoAgentAction(id, deps = {}) {
  const {
    getAction: getActionFn = getAction,
    markUndone: markUndoneFn = markUndone,
    revertMergeCommit: revertMergeCommitFn = revertMergeCommit,
    deleteBranch: deleteBranchFn = deleteBranch,
    deleteApiDoc: deleteApiDocFn = deleteApiDoc,
    revertReqChange: revertReqChangeFn = revertReqChange,
    removeSupplement: removeSupplementFn = removeSupplement,
    discardTask: discardTaskFn = discardTask,
    removeFigma: removeFigmaFn = removeFigma,
  } = deps;

  try {
    const action = getActionFn(id);
    if (!action) return { ok: false, error: `撤销记录不存在：${id}` };
    // 两种「撤不了」文案刻意区分：撤过了是操作层面的幂等提示，undo=null 是这条改动
    // 天生撤不回（external 档）——主机需要知道自己面对的是哪一种，别混着说
    if (action.undone === true) return { ok: false, error: '这条改动已经撤销过了' };
    if (!action.undo) return { ok: false, error: '这条改动已发生且撤不回，不可撤销' };

    const { undo } = action;
    let result;
    switch (undo.kind) {
      case 'revert-merge':
        // mergeSha 为空 = 还没合并过（待合并态），改动只在分支上，删分支即撤销；
        // 有 mergeSha 才需要在基线分支上做反向提交（见 revert.js 的 git revert 优先策略）
        result = undo.mergeSha
          ? await revertMergeCommitFn(undo.repo, { task: { branch: undo.branch, baseBranch: undo.baseBranch }, mergeCommit: undo.mergeSha })
          : await deleteBranchFn(undo.repo, undo.branch);
        break;
      case 'delete-apidoc':
        result = await deleteApiDocFn(undo.reqId, undo.name);
        break;
      case 'revert-req-change':
        result = await revertReqChangeFn(undo.reqId, undo.changeId);
        break;
      case 'remove-supplement':
        result = await removeSupplementFn(undo.reqId, undo.supplementId);
        break;
      case 'discard-task':
        result = await discardTaskFn(undo.taskId);
        break;
      case 'remove-figma':
        result = await removeFigmaFn(undo.reqId, undo.pageId, undo.figmaId);
        break;
      default:
        return { ok: false, error: `未知的撤销方式：${undo.kind}` };
    }

    if (!result?.ok) return { ok: false, error: result?.error || '撤销失败' };
    markUndoneFn(id);
    return { ok: true, note: result.note || null };
  } catch (e) {
    // 撤销执行本身抛错（git 炸了之类）按失败处理，绝不冒泡——冒泡会让 HTTP 层裸 500，
    // 主机看到的是一坨堆栈而不是「撤销失败，原因是……」
    return { ok: false, error: `撤销执行出错：${(e?.message || String(e)).slice(0, 200)}` };
  }
}
