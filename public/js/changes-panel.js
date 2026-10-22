/**
 * 「未提交变更」面板 —— 当前项目里相对最后一次提交还没提交的文件，各自改了什么。
 *
 * 为什么是抽屉而不是整页：它是**审计用的旁挂视图** —— 看它的时候往往还在等 AI 跑、
 * 或者在对话区对照上下文。整页视图会把对话整个换掉（看着就像开了个新窗口），
 * 关掉再打开还丢滚动位置；右侧抽屉从右往左滑出，聊天区与顶栏都还在原处。
 * 非模态：没有遮罩，点别处不会把它带走 —— 那是「边看边干活」的前提（同 .cc-drawer 的取舍）。
 *
 * 数据源是 GET /api/workspace-changes（后端跑 git、按 cwd 短 TTL 缓存），本模块只做取数与呈现。
 * **口径按项目而不是按会话**：同一目录下不管在哪个会话里，未提交的改动都是同一批，
 * 所以取 cwd 而不是 conv.session（改口径之前这里是「本次会话改动」）。
 *
 * 两种视图共用右侧 diff 面板：
 *   - 列表：左栏文件清单（±行数、新增/修改/删除），点击看 diff；
 *   - 内容地图：目录树画布，卡片底色深浅 = 改动量，点击文件节点看 diff。
 */
import { $, dirTail } from './util.js';
import { createMapCanvas } from './map-canvas.js';
import { layoutChangeMap } from './changes-map.logic.js';
import { diffSegments, toSplitRows } from './changes-diff.logic.js';
import { getCwd } from './chat.js';

/** 面板打开时的刷新间隔（AI 正在改代码时 5s 够跟手，又不会把 git 打热） */
const POLL_MS = 5000;
/** 顶栏徽标的后台轮询间隔（与 refreshTaskBadge/refreshTokenStatus 的 15s 同档） */
const BADGE_POLL_MS = 15000;

let pollTimer = null;
let badgeTimer = null;
let mapCanvas = null;
let drawer = null; // 打开中的抽屉 { host }；null = 关着（一切都是「开着才有」的，别再另立布尔）
let escHandler = null;
let pending = false;

const state = {
  data: null,
  view: 'list', // 'list' | 'map'
  diffView: 'split', // 'unified' | 'split'：默认并排（改一行看一行的对照关系最直观）
  selected: null, // 选中的文件路径
  filter: '',
  mapSig: '', // 上一次画内容地图时的节点签名（树没变就不重建画布，见 renderMap）
  error: '',
};

// ==================== 项目定位 ====================

/** 本窗项目目录；没选目录时为空串（面板据此说「先选目录」，而不是说「没有改动」） */
function currentCwd() {
  try {
    return getCwd() || '';
  } catch {
    return ''; // chat.js 尚未初始化完（脚本尾部才建状态）时不该把面板打挂
  }
}

// ==================== 取数 ====================

async function fetchChanges({ summary = false } = {}) {
  const cwd = currentCwd();
  // 没有目录就别发请求：后端会 400，而这里能直接给出更有用的一句话
  if (!cwd) return emptyPayload('', 'no-cwd');
  const r = await fetch(`/api/workspace-changes?cwd=${encodeURIComponent(cwd)}${summary ? '&view=summary' : ''}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) throw new Error(d?.error || `加载失败（${r.status}）`);
  return d;
}

function emptyPayload(cwd, reason) {
  return {
    ok: true,
    cwd,
    empty: true,
    reason,
    rev: '0',
    summary: { files: 0, added: 0, removed: 0 },
    files: [],
    tree: null,
  };
}

/**
 * 只在数据真的变了的时候重画：轮询每 5s 一次，无脑重画会把用户的滚动位置和选中态冲掉。
 *
 * rev 是后端的**内容指纹**，必须进签名：把 `bar(x)` 改成 `baz(x)` 时增删行数一个没变，
 * 只比计数的话面板会一直显示上一版内容（看着像「AI 没干活」）。
 */
function signatureOf(d) {
  if (!d) return '';
  const s = d.summary || {};
  return `${d.cwd}#${d.rev}#${s.files}/${s.added}/${s.removed}`;
}

// ==================== 抽屉 ====================

/** 打开抽屉：进入时重拉一次数据并起轮询。重复调用是幂等的（只把已有抽屉拉回前台） */
export function openChangesPanel() {
  if (drawer) return;
  const host = document.createElement('div');
  host.className = 'sc-drawer-host';
  host.innerHTML =
    '<aside class="sc-drawer" role="dialog" aria-label="未提交变更">' +
      '<div class="sc-drawer-head">' +
        '<h3 class="sc-drawer-title">未提交变更</h3>' +
        '<button type="button" class="sc-drawer-close" title="关闭（Esc）">✕</button>' +
      '</div>' +
      '<div class="sc-body" id="changesBody"></div>' +
    '</aside>';
  document.body.appendChild(host);

  host.querySelector('.sc-drawer-close').addEventListener('click', () => closeChangesPanel());
  escHandler = (e) => {
    if (e.key === 'Escape') closeChangesPanel();
  };
  document.addEventListener('keydown', escHandler);
  drawer = { host };
  document.getElementById('changesBtn')?.classList.add('active');

  state.view = 'list';
  state.selected = null;
  state.filter = '';
  state.mapSig = ''; // 换项目了：画布必须重建，否则会沿用上一个项目的节点
  state.data = null; // 旧数据必须先清掉，否则会先闪一屏别处的改动
  renderBody();
  load({ force: true });
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // 抽屉关掉时 closeChangesPanel 会清定时器；这里再判一次是因为回调可能已在队列里
    if (drawer && $('#changesBody')) load();
  }, POLL_MS);
}

/** 关抽屉：停轮询 + 收 WebGL/事件监听（画布在 window 上挂了 mousemove/mouseup，不收会累积） */
export function closeChangesPanel() {
  if (!drawer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  disposeMapCanvas();
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
  drawer.host.remove();
  drawer = null;
  document.getElementById('changesBtn')?.classList.remove('active');
}

/** 顶栏按钮的语义：点开、再点收起 */
export function toggleChangesPanel() {
  if (drawer) closeChangesPanel();
  else openChangesPanel();
}

// ==================== 骨架 ====================

/**
 * 骨架只建一次（每次开抽屉重建一次），之后各区块原地更新。
 * 每次轮询都重建 innerHTML 的话，筛选框会丢焦点、diff 滚动位置会被重置——
 * 那正是「边跑边看」这个场景最不能忍的。
 */
function ensureSkeleton() {
  const body = $('#changesBody');
  if (!body || body.dataset.built === '1') return body;
  body.dataset.built = '1';
  body.innerHTML = `
    <div class="sc-bar">
      <div class="sc-meta">
        <span class="sc-title" id="scTitle"></span>
        <span class="sc-stat" id="scStat"></span>
      </div>
      <input class="sc-filter" id="scFilter" type="search" placeholder="筛选：路径 / 目录" autocomplete="off" />
      <div class="sc-tabs">
        <button class="sc-tab active" data-sc-view="list">列表</button>
        <button class="sc-tab" data-sc-view="map">内容地图</button>
      </div>
      <button class="btn" id="scRefreshBtn">刷新</button>
    </div>
    <div class="sc-main">
      <div class="sc-files" id="scFiles"></div>
      <div class="sc-mapwrap" id="scMapWrap" hidden><div class="sc-mapmount"></div></div>
      <aside class="sc-diff" id="scDiff" hidden></aside>
    </div>
  `;

  body.querySelector('#scRefreshBtn').addEventListener('click', () => load({ force: true }));
  body.querySelector('#scFilter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim().toLowerCase();
    renderFiles();
  });
  for (const tab of body.querySelectorAll('.sc-tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.scView));
  }
  return body;
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  const body = $('#changesBody');
  for (const tab of body.querySelectorAll('.sc-tab')) {
    tab.classList.toggle('active', tab.dataset.scView === view);
  }
  renderBody();
}

// ==================== 渲染 ====================

function renderBody() {
  const body = ensureSkeleton();
  if (!body) return;
  renderHeader();

  const d = state.data;
  const hasData = !!d && !d.empty && (d.files || []).length > 0;

  body.querySelector('#scFiles').hidden = state.view !== 'list' || !hasData;
  body.querySelector('#scMapWrap').hidden = state.view !== 'map' || !hasData;
  if (!hasData) {
    body.querySelector('#scDiff').hidden = true;
    disposeMapCanvas();
    renderPlaceholder();
    return;
  }

  if (state.view === 'list') {
    disposeMapCanvas();
    renderFiles();
  } else {
    renderMap();
  }
  renderDiff();
}

function renderHeader() {
  const title = $('#scTitle');
  if (!title) return; // 抽屉已经关了：轮询的回程落在关抽屉之后，不该往空 DOM 上写
  const d = state.data;
  const s = d?.summary || { files: 0, added: 0, removed: 0 };
  const cwd = d?.cwd || currentCwd();
  title.textContent = cwd ? `项目：${dirTail(cwd)}` : '未选择项目目录';
  title.title = cwd || '';
  const parts = [`${s.files} 个文件`, `+${s.added}`, `-${s.removed}`, '与最后一次提交对比'];
  if (d?.truncated?.files) parts.push(`（改动文件过多，只列出改动最大的前 ${(d.files || []).length} 个）`);
  else if (d?.truncated?.untracked) parts.push('（未跟踪文件过多，只列出前 200 个）');
  $('#scStat').textContent = state.error ? state.error : parts.join(' · ');
  $('#scStat').classList.toggle('sc-error', !!state.error);
}

function renderPlaceholder() {
  const box = $('#scFiles');
  const cwd = state.data?.cwd || currentCwd();
  // 「没内容」有四种，必须分开说：没选目录 / 不是仓库 / 读不到 git / 真的没改。
  // 后端刻意用 reason 区分（collect.js：not-a-repo / no-changes），前端不读它的话
  // 「不是 git 仓库」就会被说成「没有改动」—— 那是最误导人的一种错（用户明明改了一堆文件，
  // 面板却告诉他工作区是干净的）。
  const reason = state.data?.reason || (cwd ? 'no-changes' : 'no-cwd');
  let text;
  if (state.error) text = state.error;
  else if (reason === 'no-cwd') text = '还没有选择项目目录。在左下角选一个目录后，这里会列出该目录下还没提交的文件。';
  else if (reason === 'not-a-repo') text = '当前项目不是 git 仓库：没有「未提交」可言，这里也就没有内容可列。';
  else text = '工作区是干净的：当前项目没有未提交的改动。';
  box.hidden = false;
  box.innerHTML = '<div class="sc-empty"><div class="sc-empty-text"></div></div>';
  box.querySelector('.sc-empty-text').textContent = text;
}

/** 卡片上的加减行：某一边为 0 就整块不画，免得满屏 +0 -0 */
function statsEl(added, removed) {
  const s = document.createElement('span');
  s.className = 'sc-stats';
  if (added) {
    const a = document.createElement('b');
    a.className = 'sc-add';
    a.textContent = `+${added}`;
    s.appendChild(a);
  }
  if (removed) {
    const r = document.createElement('b');
    r.className = 'sc-del';
    r.textContent = `-${removed}`;
    s.appendChild(r);
  }
  return s;
}

/**
 * 改动类型的三档说法 —— 与 `git status` 的 A/M/D/R 一一对应。
 * `badge` 是清单/地图卡片上的单字标记（**必须单字**：那是个 18px 的方框），
 * `short` 给地图卡片，`title` 给悬停提示与读屏。
 */
const KINDS = {
  add: { badge: '增', short: '新增', title: '新增文件' },
  modify: { badge: '改', short: '修改', title: '修改内容' },
  delete: { badge: '删', short: '已删除', title: '已删除' },
  rename: { badge: '重', short: '重命名', title: '重命名' },
};

function kindOf(f) {
  return KINDS[f?.kind] || KINDS.modify; // 未知类型按「修改」显示，不留空标记
}

/** 拆成 { dir: 'src/store/', name: 'a.js' }；无目录时 dir 为空串 */
function splitPath(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i < 0 ? { dir: '', name: s } : { dir: s.slice(0, i + 1), name: s.slice(i + 1) };
}

function renderFiles() {
  const box = $('#scFiles');
  const files = visibleFiles();
  box.textContent = '';
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'sc-empty';
    empty.textContent = '没有匹配的文件';
    box.appendChild(empty);
    return;
  }
  for (const f of files) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sc-file' + (f.path === state.selected ? ' sel' : '') + (f.deleted ? ' gone' : '');

    // 两行式：上排「文件名 + 加减行」、下排目录。单行整串路径在 330px 里必然被截，
    // 而截在尾巴上会把最要紧的文件名吃掉；拆开后文件名永不缩，只有目录会被略去。
    const { dir, name } = splitPath(f.path);
    const top = document.createElement('span');
    top.className = 'sc-file-top';
    const k = kindOf(f);
    const kind = document.createElement('span');
    kind.className = 'sc-file-kind';
    kind.textContent = k.badge;
    kind.title = k.title;
    const nm = document.createElement('span');
    nm.className = 'sc-file-name';
    nm.textContent = name; // 路径来自 git：一律 textContent
    top.append(kind, nm, statsEl(f.added, f.removed));

    const dirEl = document.createElement('span');
    dirEl.className = 'sc-file-dir';
    dirEl.textContent = f.kind === 'rename' && f.oldPath ? `${dir}（原 ${f.oldPath}）` : dir || '（项目根）';
    dirEl.title = f.path;

    row.append(top, dirEl);
    row.addEventListener('click', () => select(f.path));
    box.appendChild(row);
  }
}

function visibleFiles() {
  const all = state.data?.files || [];
  if (!state.filter) return all;
  return all.filter((f) => f.path.toLowerCase().includes(state.filter));
}

function select(path) {
  state.selected = path;
  if (state.view === 'list') renderFiles();
  renderDiff();
  if (state.view === 'map') highlightSelection();
}

function disposeMapCanvas() {
  if (mapCanvas) {
    mapCanvas.destroy(); // 内核在 window 上挂了 mousemove/mouseup，不 destroy 会随重渲染累积
    mapCanvas = null;
  }
}

function renderMap() {
  const wrap = $('#scMapWrap');
  const mount = wrap.querySelector('.sc-mapmount');

  const layout = layoutChangeMap(state.data.tree);
  const nodes = layout.nodes;

  // 树没变就不重建画布：AI 正在改代码时每 5s 会推进一次数据，重建等于把用户的缩放/平移
  // 每 5s 抹一次。节点集合与热度都没动的话，画布上的东西一模一样。
  const sig = nodes.map((n) => `${n.id}:${n.heat.toFixed(3)}`).join('|');
  if (sig === state.mapSig && mapCanvas) return;
  state.mapSig = sig;

  disposeMapCanvas();
  mount.textContent = '';

  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'sc-empty';
    empty.textContent = '没有可展示的目录结构';
    mount.appendChild(empty);
    return;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  mapCanvas = createMapCanvas(mount, {
    nodes,
    edges: layout.edges,
    renderNode: renderMapNode,
    onNodeClick: (id) => {
      // 目录节点不承载 diff：点它就把子树里的文件全部高亮，等于「看这块区域动了哪些文件」
      const n = byId.get(id);
      if (!n) return;
      if (n.data?.type === 'file') select(n.data.path);
      else highlightSubtree(n);
    },
  });
  requestAnimationFrame(() => mapCanvas?.fitView());
}

/** 目录 → 其下所有文件路径（用于点目录时高亮） */
function filesUnder(node, out = []) {
  for (const child of node?.children || []) {
    if (child.type === 'file') out.push(child.path);
    else filesUnder(child, out);
  }
  return out;
}

function highlightSubtree(node) {
  mapCanvas?.highlightNodes(filesUnder(node)); // 画布节点 id 就是树里的 path
}

function highlightSelection() {
  mapCanvas?.highlightNodes(state.selected ? [state.selected] : null);
}

function renderMapNode(node, el) {
  const d = node.data || {};
  el.classList.add('sc-node');
  // 底色深浅 = 改动量（layoutChangeMap 已按「最大文件改动量」归一）。分四档写死，
  // 不用 color-mix：桌面端 webview 的 Chromium 版本不保证支持。
  const heat = node.heat || 0;
  el.classList.add(`sc-node--h${heat >= 0.75 ? 3 : heat >= 0.4 ? 2 : heat > 0 ? 1 : 0}`);
  if (d.type === 'dir') el.classList.add('sc-node--dir');
  if (d.deleted) el.classList.add('sc-node--gone');

  const name = document.createElement('div');
  name.className = 'sc-node-name';
  name.textContent = d.type === 'dir' ? `${d.name || '(根)'}/` : d.name || d.path || '';
  name.title = d.path || '';

  const stat = document.createElement('div');
  stat.className = 'sc-node-stat';
  if (d.type === 'dir') {
    stat.textContent = `${d.files} 文件 · +${d.added} -${d.removed}`;
  } else {
    stat.appendChild(statsEl(d.added, d.removed));
    const extra = document.createElement('span');
    extra.textContent = kindOf(d).short;
    stat.appendChild(extra);
  }

  el.append(name, stat);
}

// ---------- 右侧 diff 面板 ----------

function renderDiff() {
  const pane = $('#scDiff');
  const f = (state.data?.files || []).find((x) => x.path === state.selected);
  if (!f) {
    pane.hidden = true;
    pane.textContent = '';
    return;
  }
  pane.hidden = false;
  pane.textContent = '';
  // 并排视图要更宽：左右各半栏，窄了每侧连一行 60 字符都放不下
  pane.classList.toggle('sc-diff--split', f.diffMode === 'unified' && state.diffView === 'split');

  pane.appendChild(renderDiffHead(f));
  const body = document.createElement('div');
  body.className = 'sc-hunks';
  if (f.diffMode !== 'unified' || !(f.hunks || []).length) renderNoContent(f, body);
  else if (state.diffView === 'split') renderSplit(f, body);
  else renderUnified(f, body);

  pane.appendChild(body);

  // 基线口径写清楚：面板上只写一句就够（现在只有一种基线），但不能不写
  const note = document.createElement('div');
  note.className = 'sc-baseline';
  note.textContent = '与最后一次提交（HEAD）对比：已暂存与未暂存的改动都算';
  pane.appendChild(note);
}

/**
 * 拿不到内容时的一句说明。**分开说清是哪种「没有」**：
 * 二进制 / 只有权限变化 / 文件过大 / 改动过多，用户要做的事完全不同。
 */
function renderNoContent(f, box) {
  const tip = document.createElement('div');
  tip.className = 'sc-note';
  if (f.binary) tip.textContent = '二进制文件：内容差异无法用文本展示，只能确定它变了。';
  else if (f.modeOnly) tip.textContent = '只有文件权限（模式位）变化，内容没有改动。';
  else if (f.tooLarge) tip.textContent = '文件过大（超过 512 KB），不展示内容。';
  else if (f.truncated) tip.textContent = '改动过多，未展示内容（增删行数仍是全量统计）。';
  else tip.textContent = '这个文件没有可展示的内容改动。';
  box.appendChild(tip);
}

/** 常驻的表头：路径 + 增减行 + 视图切换（统一 / 并排）+ 关闭 */
function renderDiffHead(f) {
  const head = document.createElement('div');
  head.className = 'sc-diff-head';

  const path = document.createElement('span');
  path.className = 'sc-diff-path';
  path.textContent = f.kind === 'rename' && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  path.title = f.path;
  head.appendChild(path);

  if (f.deleted) {
    const badge = document.createElement('span');
    badge.className = 'sc-del-badge';
    badge.textContent = '已删除';
    head.appendChild(badge);
  }
  if (f.binary) {
    const badge = document.createElement('span');
    badge.className = 'sc-del-badge';
    badge.textContent = '二进制';
    head.appendChild(badge);
  }

  const stat = document.createElement('span');
  stat.className = 'sc-diff-stat';
  stat.appendChild(statsEl(f.added, f.removed));
  head.appendChild(stat);

  if (f.diffMode === 'unified' && (f.hunks || []).length) {
    const tabs = document.createElement('div');
    tabs.className = 'sc-difftabs';
    for (const [key, label] of [['unified', '统一'], ['split', '并排']]) {
      const b = document.createElement('button');
      b.className = 'sc-difftab' + (state.diffView === key ? ' active' : '');
      b.dataset.scDiffView = key;
      b.textContent = label;
      b.addEventListener('click', () => {
        state.diffView = key;
        renderDiff();
      });
      tabs.appendChild(b);
    }
    head.appendChild(tabs);
  }

  const close = document.createElement('button');
  close.className = 'sc-diff-close';
  close.title = '关闭';
  close.textContent = '✕';
  close.addEventListener('click', () => {
    state.selected = null;
    if (state.view === 'list') renderFiles();
    renderDiff();
  });
  head.appendChild(close);
  return head;
}

/** 空行号：行不存在或用不上时画一个占位，保证两侧行号列宽一致、不跳动 */
function gutter(oldNo, newNo) {
  const g = document.createElement('span');
  g.className = 'sc-gutter';
  const a = document.createElement('span');
  a.className = 'sc-ln';
  a.textContent = oldNo == null ? '' : String(oldNo);
  const b = document.createElement('span');
  b.className = 'sc-ln';
  b.textContent = newNo == null ? '' : String(newNo);
  g.append(a, b);
  return g;
}

/** 源码单元：有词级分段就逐段渲染（变了的词套 <em>），否则整体一个文本节点 */
function codeCell(text, segs) {
  const code = document.createElement('span');
  code.className = 'sc-code';
  if (!Array.isArray(segs)) {
    code.textContent = text; // 源码内容一律 textContent，不拼 innerHTML
    return code;
  }
  for (const seg of segs) {
    if (seg.em) {
      const em = document.createElement('em');
      em.className = 'sc-em';
      em.textContent = seg.text;
      code.appendChild(em);
    } else {
      code.appendChild(document.createTextNode(seg.text));
    }
  }
  return code;
}

function lineRow(t, text, segs, oldNo, newNo) {
  const row = document.createElement('div');
  row.className = `sc-row sc-row--${t === '+' ? 'add' : t === '-' ? 'del' : 'ctx'}`;
  const sign = document.createElement('span');
  sign.className = 'sc-sign';
  sign.textContent = t === ' ' ? '' : t;
  row.append(gutter(oldNo, newNo), sign, codeCell(text, segs));
  return row;
}

/** hunk 之间没展示的上下文：一条折叠提示 */
function gapRow(lines) {
  const el = document.createElement('div');
  el.className = 'sc-gap';
  el.textContent = `⋯ 共 ${lines} 行未修改 ⋯`;
  el.title = '只展示改动附近各 3 行上下文（与 git 默认一致）';
  return el;
}

function hunkHead(h) {
  const head = document.createElement('div');
  head.className = 'sc-hunk-head';
  const range = document.createElement('span');
  range.className = 'sc-hunk-range';
  range.textContent = h.header;
  const right = document.createElement('span');
  right.className = 'sc-hunk-count';
  const del = document.createElement('b');
  del.className = 'sc-del';
  del.textContent = `-${h.rows.filter((r) => r.t === '-').length}`;
  const add = document.createElement('b');
  add.className = 'sc-add';
  add.textContent = `+${h.rows.filter((r) => r.t === '+').length}`;
  right.append(del, add);
  head.append(range, right);
  return head;
}

/** 统一视图：双列行号 + 单栏内容（git / GitHub 的默认形态） */
function renderUnified(f, box) {
  for (const item of diffSegments(f)) {
    if (item.type === 'gap') {
      box.appendChild(gapRow(item.lines));
      continue;
    }
    const h = item.hunk;
    const wrap = document.createElement('div');
    wrap.className = 'sc-hunk';
    wrap.appendChild(hunkHead(h));
    const body = document.createElement('div');
    body.className = 'sc-hunk-body';
    for (const r of h.rows) body.appendChild(lineRow(r.t, r.text, r.segs, r.oldNo, r.newNo));
    wrap.appendChild(body);
    box.appendChild(wrap);
  }
  noteTruncated(f, box);
}

/** 并排视图：左右各一栏，删除与插入按上标配对（同一行号对齐） */
function renderSplit(f, box) {
  for (const item of diffSegments(f)) {
    if (item.type === 'gap') {
      box.appendChild(gapRow(item.lines));
      continue;
    }
    const h = item.hunk;
    const wrap = document.createElement('div');
    wrap.className = 'sc-hunk';
    wrap.appendChild(hunkHead(h));
    const body = document.createElement('div');
    body.className = 'sc-hunk-body sc-hunk-body--split';
    for (const pair of toSplitRows(h.rows)) {
      const row = document.createElement('div');
      row.className = 'sc-split-row';
      row.append(splitHalf(pair.left, 'left'), splitHalf(pair.right, 'right'));
      body.appendChild(row);
    }
    wrap.appendChild(body);
    box.appendChild(wrap);
  }
  noteTruncated(f, box);
}

function splitHalf(row, side) {
  const half = document.createElement('div');
  half.className = `sc-half sc-half--${side}`;
  if (!row) {
    half.classList.add('sc-half--empty');
    half.append(gutter(null, null), codeCell('', null));
    return half;
  }
  const no = side === 'left' ? row.oldNo : row.newNo;
  half.classList.add(row.t === '+' ? 'sc-half--add' : row.t === '-' ? 'sc-half--del' : 'sc-half--ctx');
  half.append(gutter(no, null), codeCell(row.text, row.segs));
  return half;
}

function noteTruncated(f, box) {
  if (!f.truncated) return;
  const more = document.createElement('div');
  more.className = 'sc-more';
  more.textContent = '改动过多，仅展示前若干处（增删行数与文件清单仍是全量统计）';
  box.appendChild(more);
}

// ==================== 加载 ====================

async function load({ force = false } = {}) {
  if (pending && !force) return;
  pending = true;
  try {
    const d = await fetchChanges();
    state.error = '';
    if (signatureOf(d) !== signatureOf(state.data)) {
      state.data = d;
      // 选中的文件如果已不在列表里（换项目 / 已提交掉了），清空选中态
      if (state.selected && !(d.files || []).some((f) => f.path === state.selected)) {
        state.selected = null;
      }
      renderBody();
    } else {
      state.data = d;
      renderHeader();
    }
    // 顺手用刚拿到的数据更新徽标：这份就是最新结果，不必再为徽标多发一次请求
    applyBadge(d.summary);
    if (!state.selected && (d.files || []).length) select(d.files[0].path);
  } catch (e) {
    state.error = `加载失败：${e.message}`;
    renderHeader();
  } finally {
    pending = false;
  }
}

// ==================== 顶栏徽标 ====================

/** 把一份 summary 画到顶栏徽标上 */
function applyBadge(summary) {
  const badge = $('#changesCount');
  if (!badge) return;
  const n = summary?.files || 0;
  badge.hidden = n === 0;
  badge.textContent = String(n);
  badge.title = `当前项目有 ${n} 个文件未提交（+${summary?.added || 0} / -${summary?.removed || 0}）`;
}

/** 顶栏徽标：当前项目有几个未提交文件。轮询入口见 startChangesBadgePolling */
export async function refreshChangesBadge() {
  const badge = $('#changesCount');
  if (!badge) return;
  // 没有项目目录就明确清掉：不能留着上一个项目的数字，那会让人以为「这个项目也是这么多」
  if (!currentCwd()) {
    badge.hidden = true;
    badge.textContent = '';
    return;
  }
  try {
    const d = await fetchChanges({ summary: true });
    applyBadge(d?.summary);
  } catch {
    // 徽标是附属信息：拿不到就保持原状，不弹错也不清掉——清掉会让「刚才明明有改动」的观感变成 bug
  }
}

/**
 * 启动徽标轮询（app.js 在后端就绪后调一次）。
 *
 * 首轮刻意延后几秒：调用点是后端刚就绪，而项目目录可能还在等服务端偏好回填，
 * 立刻拉会拿到空 cwd（徽标闪一下就没有了）。
 */
export function startChangesBadgePolling() {
  setTimeout(refreshChangesBadge, 3000);
  clearInterval(badgeTimer);
  badgeTimer = setInterval(refreshChangesBadge, BADGE_POLL_MS);
}

// 挂全局给 chat.js 在 run 结束时立即刷一次（与 _refreshOptimizeBadge / _updateReqList 同一套做法）。
// 反过来让 chat.js import 本模块会成环：本模块已经从 chat.js 取 getCwd。
window._refreshChangesBadge = refreshChangesBadge;
