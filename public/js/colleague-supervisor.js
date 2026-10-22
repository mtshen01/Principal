/**
 * 同事监管面板（P5）：按人看对话 + 发消息 + 工具轨迹 + AI 改动台账（一键撤销）。
 *
 * 数据源：
 *   GET  /api/req/colleague-threads        列表（名册 × 未读 × 最近一条摘要 × 该人被指派的需求）
 *   GET  /api/req/colleague-thread?…       某人的跨需求整条线（消息含 toolTrace）
 *   GET  /api/req/agent-actions?…          该人的 AI 写操作台账（undoable 才给撤销按钮）
 *   POST /api/req/colleague-thread/read    进人即清未读（按人口径，与需求红点互不替代）
 *   POST /api/req/colleague-messages/send  回消息（按需求归属，见下）
 *
 * 视图生命周期归 app.js#showView（进入 init、离开 dispose）；本模块只管内容与轮询。
 * 气泡/行的样式复用 `.cc-*`（抽屉壳那一套视觉），布局用 `.cs-*`。
 *
 * 主动发消息（2026-10-15）：需求页右栏的「开发人员」收成纯指派入口后，跟同事说话都收到这里。
 * 发送端点是**按需求**的（reqId 必填，且该同事得在那条需求的开发人员里），而本面板按人锚定，
 * 故发消息前要先选「归属需求」—— 候选由列表端点一并给出（`reqs`，带 `phase`），与发送侧的校验同源。
 *
 * 归属候选只留**进行中**的需求（2026-10-16）：归档/废弃的需求开发会话与分支都已收尾，
 * 往里发消息同事只能回「已经归档了」，白烧一轮；选择规则见 `req-phase.logic.js`
 *（与侧栏需求列表的活动分组同一份口径）。候选只有一个时默认就选中它，不用用户动手。
 *
 * 台账（2026-10-10 改版）：不再占右列底部固定高度，收成会话标题右侧的右对齐按钮，
 * 点开走侧滑抽屉展示**当前选中同事**触发的写操作（撤销按钮仍在）。抽屉复用 `.cc-drawer*`
 * 壳（非模态 + Esc/✕ 关闭），同时只留一个；离开视图或切换同事即关。
 */
import { getJson, postJson } from './api.js';
import { renderMarkdown, isMarkdownPath, downloadFile } from './util.js';
import { DOWNLOAD_ICON_SVG } from './icons.js';
import { openMarkdownFile } from './chat.js';
import { bindDialogDismiss } from './dialog-dismiss.js';
import { messagesSignature } from './colleague-thread.logic.js';
import { splitAssignedReqs, resolveSelectedReqId } from './req-phase.logic.js';

const POLL_MS = 10_000;
const LAST_TEXT_MAX = 40; // 列表预览截断（服务端给 80，这里再收一道保证单行）

let timer = null;
let selectedId = null; // 跨「离开再进入」保留选人（用户回到这个面板时继续看同一个人的上下文）
let loadSeq = 0;
let ledgerBtnBound = false; // 台账按钮只绑一次（init 幂等，重复进入视图不该叠 handler）
let composeBound = false; // 发消息那行也只绑一次（同上）
let lastDetail = null; // 最近一次落定的详情快照 { colleagueId, colleague, actions }，抽屉首屏直接用它
let ledgerDrawer = null; // 打开中的台账抽屉 { host, colleagueId, listBox, close }
let msgSig = ''; // 消息区指纹：内容没变就不重绘（免得每 10s 打断用户正在选中的文本）
// 发消息的上下文：归属下拉的候选（该同事被指派的需求）+ 该同事本身。
// reqs 为 null 表示列表端点还没回来 —— 此时「禁用发送」而不是「当成没有需求」，
// 否则后端慢半拍的那一瞬间会显示「没有被指派任何需求」，是句假话。
let composeCtx = null;

/** colleagueId → 该人被指派的需求 [{id,title}]，随列表轮询刷新（来源见 routes-requirements.js#handleColleagueThreads） */
const assignedReqs = new Map();

// —— DOM 小工具（面板 DOM 写在 index.html 里，每次取用不缓存）——
const $ = (id) => document.getElementById(id);

function tip(text) {
  const el = document.createElement('div');
  el.className = 'cc-tip';
  el.textContent = text;
  return el;
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** 进入视图（app.js#showView 调；内部幂等，重复调用不会叠轮询） */
export function initColleagueSupervisor() {
  const root = $('colleagueSupervisorBody');
  if (!root) return;
  if (timer) clearInterval(timer);
  timer = setInterval(poll, POLL_MS);
  if (!ledgerBtnBound) {
    // 抽屉首屏用 lastDetail 快照（轮询间隙内不额外拉一次），下轮轮询会刷新它
    const btn = $('csLedgerBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        const d = lastDetail;
        if (!d || d.colleagueId !== selectedId) return; // 数据没落定不猜人
        openLedgerDrawer(d.colleagueId, d.colleague?.name || '同事', d.actions);
      });
      ledgerBtnBound = true;
    }
  }
  if (!composeBound) {
    bindCompose();
    composeBound = true;
  }
  poll();
}

/** 绑发消息那行（只绑一次：init 幂等，重复进入视图不该叠 handler） */
function bindCompose() {
  const form = $('csCompose');
  if (!form) return;
  // 用 form 的 submit 而不是按钮 click：Enter 在 textarea 里不触发表单提交，两种入口各走各的
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    sendToColleague();
  });
  const input = $('csInput');
  if (input) {
    input.addEventListener('keydown', (ev) => {
      // isComposing：中文输入法选词时的 Enter 不算发送（否则「确认候选词」会把半截话发出去）
      if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
      ev.preventDefault();
      sendToColleague();
    });
    // 随内容长高（对齐底部 composer 的手感）：先归零再按内容撑，否则删字时高度不回收
    input.addEventListener('input', () => growInput(input));
  }
}

/** 输入框长高的上限（与 .cs-input 的 max-height 对齐）；jsdom 里 scrollHeight 为 0 → 空操作 */
const INPUT_MAX_H = 160;
function growInput(el) {
  el.style.height = 'auto';
  const h = el.scrollHeight;
  if (h) el.style.height = Math.min(INPUT_MAX_H, h) + 'px';
}

/** 离开视图：停轮询 + 关台账抽屉（抽屉挂在 body 上，不关会悬在别的视图上） */
export function disposeColleagueSupervisor() {
  if (timer) clearInterval(timer);
  timer = null;
  closeLedgerDrawer();
}

async function poll() {
  const seq = ++loadSeq;
  await refreshList(seq);
  if (selectedId) await refreshDetail(selectedId, seq, { markRead: false });
}

// ============ 左列：同事列表 ============

async function refreshList(seq = loadSeq) {
  const listBox = $('csList');
  if (!listBox) return;
  const { ok, data } = await getJson('/api/req/colleague-threads').catch(() => ({ ok: false }));
  if (seq !== loadSeq) return; // 有更新的轮次在跑，丢弃旧快照
  if (!ok) {
    if (!listBox.querySelector('.cc-row')) listBox.replaceChildren(tip('加载失败，稍后自动重试'));
    return;
  }
  const threads = data?.threads || [];
  // 归属下拉的候选随列表一起刷新（列表端点已按人给出「被指派的需求」）
  for (const t of threads) assignedReqs.set(t.colleagueId, Array.isArray(t.reqs) ? t.reqs : []);
  if (!threads.length) {
    listBox.replaceChildren(tip('还没有同事。到设置页「同事设置」里添加。'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const t of threads) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cc-row' + (t.colleagueId === selectedId ? ' active' : '');
    row.dataset.id = t.colleagueId;

    // 上行：名字·职位 + 未读徽标 + 缺号提示；下行：最近一条摘要（单行省略）
    const top = document.createElement('span');
    top.className = 'cs-row-top';

    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = t.roleLabel ? `${t.name}·${t.roleLabel}` : t.name;
    top.appendChild(name);

    if (t.unread > 0) {
      const dot = document.createElement('span');
      dot.className = 'cc-badge';
      dot.textContent = t.unread > 99 ? '99+' : String(t.unread);
      top.appendChild(dot);
    }
    if (!t.feishuOpenId) {
      const tl = document.createElement('span');
      tl.className = 'tl';
      tl.textContent = '未填飞书 ID';
      top.appendChild(tl);
    }
    row.appendChild(top);

    const sub = document.createElement('span');
    sub.className = 'cs-row-sub';
    sub.textContent = t.hasThread
      ? `${t.lastAt ? fmtTime(t.lastAt) + ' · ' : ''}${(t.lastText || '').slice(0, LAST_TEXT_MAX)}`
      : '暂无对话';
    row.appendChild(sub);

    row.addEventListener('click', () => selectThread(t.colleagueId));
    frag.appendChild(row);
  }
  listBox.replaceChildren(frag);
}

function selectThread(colleagueId) {
  if (selectedId === colleagueId) return;
  selectedId = colleagueId;
  msgSig = ''; // 换人后消息区必须重绘一次（指纹是给「同一个人」的轮询用的）
  const input = $('csInput');
  if (input) {
    input.value = ''; // 上一位的草稿不能跟着带到下一位：手一按 Enter 就发错人了
    input.style.height = ''; // 高度跟着清空回收（否则留上一位的 3 行高）
  }
  // 立刻把选中态刷到列表上，不等下一轮轮询
  document.querySelectorAll('#csList .cc-row').forEach((r) => r.classList.toggle('active', r.dataset.id === colleagueId));
  // 旧快照属于上一位同事：连带按钮禁用 + 关抽屉，防「点了按钮开的是别人的台账」
  lastDetail = null;
  setLedgerBtnEnabled(false);
  closeLedgerDrawer();
  const seq = ++loadSeq;
  refreshDetail(colleagueId, seq, { markRead: true });
}

function setLedgerBtnEnabled(on) {
  const btn = $('csLedgerBtn');
  if (btn) btn.disabled = !on;
}

// ============ 右列：发消息（归属需求 + 输入框） ============

/**
 * 同步「归属需求」下拉与发送区的可用性。
 *
 * 每轮轮询都会调一次，所以**从不碰输入框的值** —— 碰了就等于把用户正在打的字定期清掉。
 * 下拉的选项也只在名单真的变了时重建（轮询重刷会把展开中的下拉收掉，
 * 且会把用户选好的那条重置回第一条）。
 *
 * 候选只列**进行中**的需求（归档/废弃不能选，见 req-phase.logic.js）；只有一个候选时
 * 默认就选中它（resolveSelectedReqId 的「回落第一条」天然覆盖）。候选全被筛掉时，
 * 提示要说清是「都已归档」而不是「没被指派」—— 后者是句假话，用户会去查并不存在的问题。
 *
 * @param {object|null} colleague 当前选中的同事（null = 没人 / 加载失败）
 * @param {Array<{id:string,title:string,phase?:string}>|null} reqs 该同事被指派的需求；null = 还没拿到
 */
function renderCompose(colleague, reqs) {
  const form = $('csCompose');
  const sel = $('csReqSelect');
  const input = $('csInput');
  const btn = $('csSendBtn');
  const hintEl = $('csComposeHint');
  if (!form || !sel || !input || !btn) return;
  composeCtx = colleague ? { colleague, reqs } : null;
  if (!colleague) {
    form.hidden = true;
    return;
  }
  form.hidden = false;

  // reqs === null（列表端点还没回来）时当作空候选 → 下面按「加载中」禁用，不会误导成「没有需求」
  const { active, archived } = splitAssignedReqs(reqs || []);
  const ids = active.map((r) => r.id).join(',');
  if (sel.dataset.ids !== ids) {
    const keep = sel.value;
    const frag = document.createDocumentFragment();
    for (const r of active) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.title || r.id;
      frag.appendChild(opt);
    }
    sel.replaceChildren(frag);
    sel.dataset.ids = ids;
    sel.value = resolveSelectedReqId(active, keep);
  }

  const loading = reqs === null;
  const none = !loading && !active.length;
  const noId = !colleague.feishuOpenId;
  const canSend = !loading && !none && !noId;
  sel.disabled = !canSend;
  input.disabled = !canSend;
  btn.disabled = !canSend;
  if (hintEl) {
    hintEl.textContent = loading
      ? '归属需求加载中…'
      : none
        ? archived.length
          ? `该同事的需求都已归档（${archived.length} 条），不能再发消息`
          : '该同事没有被指派到任何需求，无法发送（先到需求页右栏「开发人员」指派）'
        : noId
          ? '该同事未填飞书 open_id，无法发送（到设置页「同事设置」补上）'
          : '';
  }
}

/**
 * 发一条消息给当前选中的同事。
 *
 * 发送能成功的前提三条（都由服务端把关，前端只负责别让用户白填）：选了归属需求、
 * 该同事在那条需求的开发人员里、该同事有飞书 open_id。
 */
async function sendToColleague() {
  const colleagueId = selectedId;
  const reqId = $('csReqSelect')?.value || '';
  const input = $('csInput');
  const btn = $('csSendBtn');
  const text = (input?.value || '').trim();
  // 数据没落定不猜人（同台账按钮：宁可什么都不做，也不把消息发给上一个选中的人）
  if (!colleagueId || !composeCtx || composeCtx.colleague.id !== colleagueId) return;
  if (!reqId) return window.toast.error('请先选择这条消息归属的需求');
  if (!text) return window.toast.error('消息内容不能为空');

  const name = composeCtx.colleague.name || '同事';
  if (btn) btn.disabled = true;
  try {
    const { ok, data } = await postJson('/api/req/colleague-messages/send', { reqId, colleagueId, text });
    if (!ok) {
      // 草稿留着：失败多半是「未启用机器人 / 没填 open_id」这类可修的问题，改完能直接重发
      window.toast.error(data?.error || '发送失败');
      return;
    }
    if (input) {
      input.value = '';
      input.style.height = ''; // 发送后收回两行高（与底部 composer 同款手感）
    }
    window.toast.success(`已发送给 ${name}`);
    msgSig = ''; // 强制重绘，让刚发的这条立刻出现（指纹看不出「内容没变」会被跳过）
    const seq = ++loadSeq;
    await refreshDetail(colleagueId, seq, { markRead: false });
  } catch {
    window.toast.error('网络错误');
  } finally {
    // 成功路径上 refreshDetail 已经重算过禁用态，失败/异常路径得自己恢复 ——
    // 不恢复的话按钮一直灰着，用户会以为界面卡死
    const ctx = composeCtx;
    if (ctx) renderCompose(ctx.colleague, ctx.reqs);
  }
}

// ============ 右列：会话流 + 台账抽屉 ============

async function refreshDetail(colleagueId, seq = loadSeq, { markRead = false } = {}) {
  const head = $('csThreadHead');
  const msgs = $('csMsgs');
  if (!head || !msgs) return;

  const [threadRes, actionsRes] = await Promise.all([
    getJson(`/api/req/colleague-thread?colleagueId=${encodeURIComponent(colleagueId)}`).catch(() => ({ ok: false })),
    getJson(`/api/req/agent-actions?colleagueId=${encodeURIComponent(colleagueId)}`).catch(() => ({ ok: false })),
  ]);
  if (seq !== loadSeq || selectedId !== colleagueId) return; // 过期响应：用户已经切去看别人了

  if (!threadRes.ok) {
    head.textContent = '加载失败，稍后自动重试';
    setLedgerBtnEnabled(false);
    lastDetail = null;
    renderCompose(null, null); // 人是谁都没确定，先把发送区藏起来（下一轮轮询自愈）
    return;
  }
  const { colleague, messages = [], reqTitles = {} } = threadRes.data || {};
  renderThreadHead(head, colleague, messages.length);

  renderMessages(msgs, messages, reqTitles);
  // 归属下拉的候选来自**列表**端点（不在本端点里再拉一次需求全量）
  renderCompose(colleague, assignedReqs.get(colleagueId) ?? null);

  const actions = actionsRes.ok ? actionsRes.data?.actions || [] : null;
  lastDetail = { colleagueId, colleague, actions };
  setLedgerBtnEnabled(true);
  // 抽屉开着就跟着轮询刷新；若已被切到别的同事（理论上 selectThread 已关），兜底关掉
  if (ledgerDrawer) {
    if (ledgerDrawer.colleagueId === colleagueId) renderActions(ledgerDrawer.listBox, actions);
    else closeLedgerDrawer();
  }

  // 进人清未读（失败无所谓，下一轮再试）
  if (markRead) postJson('/api/req/colleague-thread/read', { colleagueId }).catch(() => {});
}

/** 会话标题行：姓名（角色）· 飞书 ID · 消息数。ID 用 span 独立渲染，窄屏省略时悬浮看全 */
function renderThreadHead(head, colleague, msgCount) {
  head.replaceChildren();
  if (!colleague) return;
  const name = document.createElement('span');
  name.textContent = `${colleague.name}（${colleague.role || '同事'}）`;
  const oid = document.createElement('span');
  oid.textContent = colleague.feishuOpenId ? ` · 飞书 ID：${colleague.feishuOpenId}` : ' · 未绑飞书';
  const cnt = document.createElement('span');
  cnt.textContent = ` · ${msgCount} 条消息`;
  head.append(name, oid, cnt);
  head.title = head.textContent;
}

function renderMessages(box, messages, reqTitles) {
  // 只在内容变化时重绘：每 10s 无脑重绘会打断用户正在选中的文本。
  // 判据是「条数 + 末条 id」而非条数（满 MAX_MESSAGES 后条数恒定），见 colleague-thread.logic.js
  const sig = messagesSignature(messages);
  if (sig === msgSig) return;
  msgSig = sig;
  if (!messages.length) {
    box.replaceChildren(tip('还没有消息。'));
    return;
  }
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = 'cc-msg ' + (m.dir === 'out' ? 'out' : 'in');

    if (m.text) {
      const body = document.createElement('div');
      body.className = 'cc-body';
      // 外部文本一律走带消毒的 renderMarkdown（与抽屉同一纪律）
      renderMarkdown(body, m.text);
      row.appendChild(body);
    }

    for (const f of m.files || []) {
      const wrap = document.createElement('span');
      wrap.className = 'cc-file-row';
      const canOpen = isMarkdownPath(f.path);
      const fileEl = document.createElement(canOpen ? 'button' : 'span');
      fileEl.className = 'cc-file';
      fileEl.textContent = '📎 ' + (f.name || f.path);
      fileEl.title = canOpen ? `${f.path}\n点击在 Markdown 查看器中打开` : f.path;
      if (canOpen) {
        fileEl.type = 'button';
        fileEl.addEventListener('click', () => {
          if (!openMarkdownFile(f.path)) window.toast.error('Markdown 查看器未就绪，请刷新页面重试');
        });
      }
      wrap.appendChild(fileEl);
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'cc-file-dl';
      dl.innerHTML = DOWNLOAD_ICON_SVG; // 本模块内联常量，非外部文本
      dl.title = '下载';
      dl.setAttribute('aria-label', `下载 ${f.name || f.path}`);
      dl.addEventListener('click', () => downloadFile(f.path, f.name || ''));
      wrap.appendChild(dl);
      row.appendChild(wrap);
    }

    // 归属标签：agent 判出来的 reqId → 标题（判不出来就不显示，不硬塞）
    if (m.reqId) {
      const reqTag = document.createElement('span');
      reqTag.className = 'cs-req-tag';
      reqTag.textContent = `→ ${reqTitles[m.reqId] ? '《' + reqTitles[m.reqId] + '》' : m.reqId}`;
      row.appendChild(reqTag);
    }

    // 工具轨迹（出站消息才有；入站恒 null）：每条工具一个 chip，完整入参放 title 悬浮
    if (Array.isArray(m.toolTrace) && m.toolTrace.length) {
      const trace = document.createElement('span');
      trace.className = 'cs-trace';
      for (const t of m.toolTrace) {
        const chip = document.createElement('span');
        chip.className = 'cs-tool';
        chip.textContent = '🛠 ' + (t.name || '未知');
        try {
          chip.title = JSON.stringify(t.input || {}).slice(0, 300);
        } catch {
          chip.title = '';
        }
        trace.appendChild(chip);
      }
      row.appendChild(trace);
    }

    // AI 处理注记（入站消息被系统处理后的落点，如「已处理（待合并） · …」）
    if (m.dir === 'in' && m.handledBy) {
      const note = document.createElement('span');
      note.className = 'cs-handled';
      note.textContent = `🤖 ${m.handledBy === 'ai' ? 'AI 已处理' : '已人工处理'}${m.handledNote ? ' · ' + m.handledNote : ''}`;
      row.appendChild(note);
    }

    const at = document.createElement('div');
    at.className = 'cc-at';
    at.textContent = fmtTime(m.at);
    row.appendChild(at);
    frag.appendChild(row);
  }
  box.replaceChildren(frag);
  if (stick) box.scrollTop = box.scrollHeight;
}

function renderActions(box, actions) {
  if (actions === null) {
    box.replaceChildren(tip('台账加载失败，稍后自动重试'));
    return;
  }
  if (!actions.length) {
    box.replaceChildren(tip('这位同事还没有 AI 写操作记录。'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const a of actions) {
    const row = document.createElement('div');
    row.className = 'cs-act';

    const name = document.createElement('span');
    name.className = 'cs-act-name';
    name.textContent = a.tool || '未知工具';
    row.appendChild(name);

    const brief = document.createElement('span');
    brief.className = 'grow';
    brief.textContent = a.resultBrief || '';
    brief.title = a.resultBrief || '';
    row.appendChild(brief);

    const time = document.createElement('span');
    time.className = 'tl';
    time.textContent = fmtTime(a.at);
    row.appendChild(time);

    const undoable = !!a.undo && a.undone !== true;
    if (undoable) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn cs-undo';
      btn.textContent = '撤销';
      btn.addEventListener('click', () => doUndo(a.id, btn));
      row.appendChild(btn); // 老位置漏了这行——撤销按钮从未真正上过屏
    } else {
      const tag = document.createElement('span');
      tag.className = 'tl';
      tag.textContent = a.undone ? '已撤销' : '撤不回';
      row.appendChild(tag);
    }
    frag.appendChild(row);
  }
  box.replaceChildren(frag);
}

// ============ 台账抽屉 ============

/**
 * 打开台账抽屉：展示**当前选中同事**触发的 AI 写操作。
 * 复用抽屉壳 `.cc-drawer*`（非模态 + Esc/✕ 关闭，理由见 app.css 里 .cc-drawer-host 那段）；
 * 同时只留一个。
 */
function openLedgerDrawer(colleagueId, name, actions) {
  closeLedgerDrawer();
  const host = document.createElement('div');
  host.className = 'cc-drawer-host';
  host.innerHTML =
    '<aside class="cc-drawer">' +
    '<div class="cc-drawer-head">' +
    '<h3 class="cc-drawer-title"></h3>' +
    '<button type="button" class="cc-close" title="关闭">✕</button>' +
    '</div>' +
    '<div class="cs-actions"></div>' +
    '</aside>';
  host.querySelector('.cc-drawer-title').textContent = `${name} · AI 改动台账`;
  const listBox = host.querySelector('.cs-actions');
  const close = bindDialogDismiss(host, () => {
    host.remove();
    if (ledgerDrawer?.host === host) ledgerDrawer = null;
  });
  host.querySelector('.cc-close').addEventListener('click', close);
  renderActions(listBox, actions === undefined ? null : actions);
  document.body.appendChild(host);
  ledgerDrawer = { host, colleagueId, listBox, close };
}

/** 关台账抽屉（close 自带幂等，重复调用安全） */
function closeLedgerDrawer() {
  ledgerDrawer?.close();
}

async function doUndo(actionId, btn) {
  btn.disabled = true;
  try {
    const { ok, data } = await postJson('/api/req/agent-action/undo', { id: actionId });
    if (!ok) {
      window.toast.error(data?.error || '撤销失败');
      return;
    }
    window.toast.success(data?.note ? `已撤销：${data.note}` : '已撤销');
    const seq = ++loadSeq;
    if (selectedId) await refreshDetail(selectedId, seq, { markRead: false });
  } catch {
    window.toast.error('网络错误');
  } finally {
    btn.disabled = false;
  }
}
