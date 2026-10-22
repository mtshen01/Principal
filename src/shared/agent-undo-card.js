/**
 * 同事 agent 改动的「主机撤销卡片」—— 构造与回调解析（纯函数）。
 *
 * 场景（P5）：`colleague-dev.js` 的 agent 改码提交/合并完成后，把「同事哪条消息引发的改动」
 * 推给主机，卡片带 [撤销这次改动]：点了按台账锚点（revert-merge / 删分支）撤回去。
 *
 * 三段式数据流（推送在 web 进程、回调在 feishu 进程、撤销执行在 web 进程）：
 *   colleague-dev.js（web）→ sendCardToUser → 主机飞书
 *   按钮点击 → feishu 进程 `colleague-agent/card-action.js`
 *             → POST /api/req/agent-action/undo → web 执行撤销 → updateCard 回执
 *
 * 按钮 value 自带 actionId（agent-actions 台账条目 id），**无内存态** ——
 * 机器人重启后躺在聊天记录里的旧卡片按钮照样有效（同 task-notify 的纪律）。
 * 放 shared 而非某个插件：推送侧在 entrypoints/web、解析侧在 plugins，shared 是唯一共用层。
 */

export const AGENT_UNDO_CARD_KIND = 'agent-undo';

const OUTCOME_HEAD = {
  merged: '✅ **同事改动已完成并合并**',
  'pending-merge': '⏳ **同事改动已完成（待合并）**',
  'merge-failed': '⚠️ **同事改动已提交，但合并失败**',
};

/**
 * 构造撤销卡片。正文把「撤销会发生什么」说清楚——两种结局的撤销语义不同
 *（已合并=反向提交；待合并=删分支），不说清会让主机不敢点或点错预期。
 *
 * @param {object} a
 * @param {string} a.actionId 台账条目 id（撤销锚点）
 * @param {string} [a.colleagueName]
 * @param {string} [a.reqTitle]
 * @param {string} [a.branch]
 * @param {string} [a.baseBranch]
 * @param {'merged'|'pending-merge'|'merge-failed'} a.outcome
 */
export function buildAgentUndoCard({ actionId, colleagueName, reqTitle, branch, baseBranch, outcome }) {
  const head = OUTCOME_HEAD[outcome] || 'ℹ️ **同事改动已处理**';
  const lines = [head];
  lines.push(`${colleagueName ? '来自 ' + colleagueName : '来自同事'}${reqTitle ? ' · 需求「' + reqTitle + '」' : ''}`);
  // 两者都有才显示：缺一个就拼出「分支：x → null」，不如不显示（同 task-notify 判据）
  if (branch && baseBranch) lines.push(`分支：${branch} → ${baseBranch}`);
  if (outcome === 'merged') lines.push('撤销 = 在基线分支上做一次反向提交。');
  else if (outcome) lines.push('改动还在分支上、尚未进基线；撤销 = 删除该分支。');

  return {
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🗑 撤销这次改动' },
            type: 'danger',
            value: { kind: AGENT_UNDO_CARD_KIND, actionId },
          },
        ],
      },
    ],
  };
}

/** 点击后的终态卡片：按钮消失，只留结果（防重复点击 + 结果留在聊天记录里） */
export function buildAgentUndoResultCard({ ok, error, note } = {}) {
  const content = ok
    ? `✅ **已撤销**${note ? '\n' + note : ''}`
    : `❌ **撤销失败**\n${error || '未知原因'}${error ? '（可稍后再试；失败不会标记为已撤销）' : ''}`;
  return { elements: [{ tag: 'div', text: { tag: 'lark_md', content } }] };
}

/**
 * 解析卡片回调 → { actionId, operatorOpenId, messageId }；非本 kind / 缺 actionId /
 * 结构异常一律 null（与 parseTaskCardAction 同款：value 兼容对象与 JSON 字符串两种形态）。
 */
export function parseAgentUndoCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== AGENT_UNDO_CARD_KIND) return null;
  if (typeof value.actionId !== 'string' || !value.actionId) return null;
  return {
    actionId: value.actionId,
    operatorOpenId: data?.operator?.open_id || null,
    messageId: data?.context?.open_message_id || data?.message_id || null,
  };
}
