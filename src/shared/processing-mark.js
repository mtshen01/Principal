/**
 * 「正在处理」标记 —— 机器人贴在用户消息上的那个表情的生命周期（纯逻辑 + 定时器注入，无 IO）。
 *
 * 语义：**标记活在「这条消息引发的终态答复」上，而不是 dispatch 返回上**。
 * 反例（本模块存在的理由）：同事消息只在飞书进程的中继层转一圈（几百毫秒）就返回，
 * 真正跑 agent 的是 web 进程、答复几秒到两分钟后才发出；旧实现按 dispatch 返回就摘，
 * 用户看到的是「表情贴了一下就没了，机器人其实还在想」——正是 2026-10-14 的反馈。
 *
 * 三种归属，按流程形态选（调用方 = entrypoints/feishu 的收信路径）：
 * - 默认：`settle()` 时摘 —— 同步流程的原行为（claude-exec、材料池、评审卡片等，
 *   它们的答复在 dispatch 返回前已发出）。
 * - `hold(promise)`：**进程内**的异步延续（反馈的后续分析 / 评审流、数据查询的后台分析）——
 *   等它落地再摘；可登记多个，全部落地才摘。
 * - `transfer()`：摘除责任**跨进程**移交（同事对话：答复由 web 进程发出，标记也该在那时摘）——
 *   本进程不再摘；摘除锚点（messageId + reactionId）随 relay payload 带给 web，
 *   由 web 在终态答复发出后调用 `lark.js#removeReactionWithCreds` 摘掉。
 *
 * 兜底上限 `maxHoldMs` 对 hold / transfer 两种形态生效（同步流程不装：它的摘除时机就是
 * dispatch 返回，装上限反而会把「跑了 20 分钟但仍在工作」的表情误摘）。
 * 没有它，任何一个卡死的延续（或移交后远端没摘走）都会让表情永远挂在用户的留言上。
 * 上限触发时：已移交 → 静默摘（远端多半已摘，删除失败属预期，不写日志）；
 * 未移交 → warn + 摘（这是真卡死了，要能在日志里看见）。
 */
import { logger } from './logger.js';

/** 标记的兜底上限：15 分钟足够覆盖所有合法流程（最长的后台数据查询预算 12 分钟） */
export const MARK_MAX_MS = 15 * 60 * 1000;

/**
 * @param {object} a
 * @param {string} [a.messageId]  被贴表情的消息 id（跨进程移交时随 payload 带走）
 * @param {string} [a.reactionId] 表情的 reaction_id（摘除凭据；为空表示压根没贴上）
 * @param {(opts?:{quiet?:boolean})=>any} [a.release] 摘除动作（飞书侧是 channel.removeReaction；
 *   约定不抛错——抛了本模块也兜住，绝不卡住 settle 的等待方）。quiet=true 表示失败属预期。
 * @param {number} [a.maxHoldMs] 兜底上限
 * @param {Function} [a.setTimer] / @param {Function} [a.clearTimer] 注入便于单测
 */
export function createProcessingMark({
  messageId = '',
  reactionId = '',
  release = null,
  maxHoldMs = MARK_MAX_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const holds = new Set(); // 未落地的异步延续
  let released = false;
  let transferred = false;
  let settleCalled = false;
  let resolveReleased = null;
  let capTimer = null;
  const releasedPromise = new Promise((resolve) => (resolveReleased = resolve));

  async function doRelease(opts = {}) {
    if (released) return;
    released = true;
    if (capTimer) clearTimer(capTimer);
    try {
      await release?.(opts);
    } catch (e) {
      // release 由调用方注入（真实的 channel.removeReaction 自身永不抛）；这里再兜一层，
      // 绝不让「摘除失败」把 settle 的等待方卡死
      logger.warn('processing-mark', '摘除处理中标记失败', { messageId, err: e?.message || String(e) });
    }
    resolveReleased();
  }

  // 兜底上限：**只对有延续（hold）/ 已移交（transfer）的标记武装**。
  // 同步流程（claude-exec 的 run 可以跑很久）不装定时器 —— 它的摘除时机是 dispatch 返回，
  // 上限装上去反而会把「跑了 20 分钟但仍在工作」的表情误摘（旧行为没有上限，不要引入回归）。
  // unref：不吊住进程退出。移交形态的兜底刻意不写日志：这是正常移交都会发生的
  // 「远端多半已摘」路径，逐条打日志只会把日志刷成噪音。
  function armCap() {
    if (capTimer || released) return;
    capTimer = setTimer(() => {
      if (released) return;
      if (transferred) {
        doRelease({ quiet: true });
      } else {
        logger.warn('processing-mark', '处理中标记超过上限被强制摘除', { messageId, holds: holds.size });
        doRelease();
      }
    }, maxHoldMs);
    capTimer?.unref?.();
  }

  /** 所有延续落地且已 settle → 摘 */
  function maybeRelease() {
    if (released || transferred) return;
    if (settleCalled && holds.size === 0) doRelease();
  }

  return {
    messageId,
    reactionId,
    get transferred() {
      return transferred;
    },
    /**
     * 登记一个进程内的异步延续：它落地（含失败）之前不摘标记。
     * 已摘 / 已移交时是 no-op —— 调用方不必判断时机，照常登记即可。
     */
    hold(promise) {
      if (released || transferred) return;
      armCap(); // 有延续才需要一个上限兜底它
      const p = Promise.resolve(promise)
        .catch(() => {}) // 延续失败也算「这一轮处理完了」；失败原因由延续自己的 catch 分支回告/留痕
        .finally(() => {
          holds.delete(p);
          maybeRelease();
        });
      holds.add(p);
    },
    /** 摘除责任移交别处（跨进程）：本进程不再摘，只剩上限兜底 */
    transfer() {
      if (released) return;
      transferred = true;
      armCap(); // 远端万一没摘，上限是唯一兜底
    },
    /**
     * dispatch 返回后的收尾入口。返回的 promise 在本进程对标记的处置完成时 resolve：
     * 无延续 → 摘除完成；有延续 → 全部落地并摘除；已移交 → 立即 resolve（远端摘 / 上限兜底）。
     */
    settle() {
      settleCalled = true;
      if (!transferred) maybeRelease();
      return transferred ? Promise.resolve() : releasedPromise;
    },
  };
}
