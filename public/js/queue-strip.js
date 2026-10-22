/**
 * 排队卡片条（queue-first）：输入框上方的待投递消息卡片。
 *
 * 形态对齐 OpenCode 的排队项：一条消息一张卡，右侧两个动作——
 *   立即发送（↑）：把这条消息插进正在运行的任务（steer-now），不必等它跑完；
 *   ✕：撤回，从队列移除，不影响正在运行的任务。
 * 排队中的消息不进转录流；被投递（消费/排空起新轮）时才由 chat.js 上屏为普通用户消息。
 *
 * 本模块只做渲染与交互；状态与出网由 chat.js 持有（服务端 /api/run/queue 是唯一真相）。
 */

// ↑ 箭头（fill=currentColor：跟随按钮文字色，与 .q-btn 的 hover 样式一致）
const STEER_ICON_SVG =
  '<svg class="q-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M512 128 870.4 486.4h-230.4V896H384V486.4H153.6L512 128z" fill="currentColor"></path></svg>';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root 卡片容器（#queueStrip）
 * @param {(id:string)=>void} [opts.onSteer] 「立即发送」点击回调
 * @param {(id:string)=>void} [opts.onWithdraw] 「✕」点击回调
 */
export function createQueueStrip({ root, onSteer, onWithdraw }) {
  /**
   * 渲染卡片列表。
   * @param {Array<{id:string,text:string,mode:'queue'|'steer'}>} items 服务端清单镜像（旧→新）
   * @param {{pendingId?:string|null}} [opts] 正在出网的卡片 id（按钮防抖：显示「发送中…」并禁用）
   */
  function render(items, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const pendingId = opts.pendingId || null;
    root.replaceChildren();
    if (!list.length) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    for (const it of list) root.appendChild(buildCard(it, pendingId));
  }

  function buildCard(it, pendingId) {
    const steering = it.mode === 'steer'; // 已点「立即发送」、等待接入当前任务（服务端持有区）
    const waiting = steering || it.id === pendingId;

    const card = document.createElement('div');
    card.className = 'queue-card' + (steering ? ' steering' : '');
    card.dataset.msgId = it.id;

    const text = document.createElement('div');
    text.className = 'qc-text';
    text.textContent = it.text || '';
    text.title = it.text || '';

    const actions = document.createElement('div');
    actions.className = 'qc-actions';

    const steer = document.createElement('button');
    steer.type = 'button';
    steer.className = 'q-btn q-btn-text qc-steer';
    steer.title = steering ? '已发送，正在接入当前任务' : '立即发送：插进正在运行的任务，不必等它跑完';
    if (waiting) {
      steer.disabled = true;
      steer.textContent = '发送中…';
    } else {
      steer.innerHTML = STEER_ICON_SVG + '<span>立即发送</span>';
      steer.addEventListener('click', () => {
        if (onSteer) onSteer(it.id);
      });
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'q-btn qc-x';
    remove.title = steering ? '已发送，正在接入当前任务' : '撤回：从队列移除，不影响正在运行的任务';
    remove.textContent = '✕';
    if (waiting) {
      remove.disabled = true;
    } else {
      remove.addEventListener('click', () => {
        if (onWithdraw) onWithdraw(it.id);
      });
    }

    actions.append(steer, remove);
    card.append(text, actions);
    return card;
  }

  return { render };
}
