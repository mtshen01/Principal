/** 会话存储 + 气泡缓存守护（「存储=DOM=_bubbleMap 三方同序」不变量的两侧收敛点）。
 *  convs 走 localStorage（500ms 防抖 + beforeunload flush）；_bubbleMap 只经本模块守护函数触碰，
 *  app.js 侧不得直接操作 Map——任何 splice/move/reorder 必须两侧一起动（见 moveMessageToEnd）。
 *
 *  ⚠️ claude_convs 是**多窗口共享的整表键**：一窗一项目（chat.js 的 openProjectWindow），
 *  几个项目窗口同 origin、同键，各持一份内存镜像。所以**禁止**
 *  「loadConvs() 拿旧镜像 → 改 → saveConvs() 整表覆盖」：那个窗口只要落后于别人，
 *  覆盖时就会把别的窗口刚建的会话、刚写的消息整片抹掉。所有写入一律走 mutateConvs
 *  （读最新 → 改 → 写回），它的起点永远是 localStorage 的当前内容。
 */
import { lsSet, lsGet } from './util.js';

const CONV_KEY = 'claude_convs';
// ---- localStorage 镜像（减少 JSON.parse/stringify 频率）----
let _convsCache = null; // null 表示尚未初始化
let _convsRaw = null; // 与 _convsCache 对应的 localStorage 原文；不等 = 别的窗口改过
let _convsSaveTimer = null;
// ---- 气泡 DOM 引用缓存（convId → Element[]，避免 querySelectorAll 线性扫描）----
const _bubbleMap = new Map(); // convId -> [bubbleEl, bubbleEl, ...]
// 别的窗口改了会话列表时的订阅者（chat.js 用它重画左栏）
const _changeListeners = new Set();
let _boundWin = null; // 已挂 storage 监听的 window（幂等绑定用）

function parseConvs(raw) {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 采纳一份原文为当前镜像（解析失败按空表，与原先 JSON.parse 失败的降级一致） */
function adoptConvs(raw) {
  _convsCache = parseConvs(raw);
  _convsRaw = raw;
  return _convsCache;
}

/** 按 id 合并两份会话表：同 id 取 updatedAt 更大的一方（本窗刚动过的自然更新）。
 *  只在「本窗有还没落盘的改动」时用来对齐外部写入——那会儿直接采纳外部内容会把自己
 *  刚发的消息吞掉（而且视图里 DOM 已经有那个气泡，索引会错位）。
 *  代价：这 500ms 内别的窗口删掉的会话会被本窗合并回来（用户再删一次即可，比丢消息轻）。 */
function mergeConvs(mine, theirs) {
  const byId = new Map((mine || []).map((c) => [c.id, c]));
  for (const t of theirs || []) {
    const m = byId.get(t.id);
    if (!m || (t.updatedAt || 0) > (m.updatedAt || 0)) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/** 读（快路径）：返回本窗镜像，首次调用时从 localStorage 载入。
 *  只用于「看」；要改必须走 mutateConvs（它会先取最新）。 */
export function loadConvs() {
  return _convsCache !== null ? _convsCache : adoptConvs(lsGet(CONV_KEY));
}

/** 读（最新）：别的窗口可能刚写过，原文变了就重新解析并替换镜像。
 *  这是所有改动的起点——比 loadConvs 多一次 getItem，但不会再拿着陈旧镜像去覆盖别人。 */
export function reloadConvs() {
  const raw = lsGet(CONV_KEY);
  if (_convsCache !== null && raw === _convsRaw) return _convsCache;
  // 本窗还有没落盘的改动（500ms 防抖窗口内）：不能直接采纳外部内容，先合并落盘再继续
  if (_convsSaveTimer !== null) return settlePending();
  return adoptConvs(raw);
}

/**
 * 改会话列表的唯一入口：以 localStorage 的当前内容为底做改动再写回。
 * fn 直接改传入的数组；返回字面量 false 表示「没改动」（目标会话不存在等）→ 不写。
 * @param {(list: Array) => (void|false)} fn
 * @returns {Array|null} 改动后的列表；未改动返回 null
 */
export function mutateConvs(fn) {
  const list = reloadConvs();
  if (fn(list) === false) return null;
  saveConvs(list);
  return list;
}

/** 写回（500ms 防抖）。调用方必须传 mutateConvs/reloadConvs 取到的最新列表。 */
export function saveConvs(list) {
  _convsCache = list; // 内存立即更新（快路径）
  clearTimeout(_convsSaveTimer);
  _convsSaveTimer = setTimeout(() => {
    _convsSaveTimer = null;
    writeConvs();
  }, 500);
}

/** 真正落盘。写成功才把原文记下（下次 reloadConvs 才敢信内存）。
 *  写失败（配额满/隐私模式）刻意**不**更新 _convsRaw：让内存继续当本窗的真相，
 *  否则下一次 reloadConvs 会用磁盘上的旧快照把用户刚发的消息吞回去。 */
function writeConvs() {
  const json = JSON.stringify(_convsCache || []);
  if (lsSet(CONV_KEY, json)) _convsRaw = json;
}

/** 「自己 + 外部」合并后立刻落盘，并返回合并结果（仍是本窗镜像）。
 *  防抖窗口内别的窗口写了新内容时走这条路：两边的东西都保住。 */
function settlePending() {
  _convsCache = mergeConvs(_convsCache, parseConvs(lsGet(CONV_KEY)));
  clearTimeout(_convsSaveTimer);
  _convsSaveTimer = null;
  writeConvs();
  return _convsCache;
}

/** 强制立即写 localStorage（页面卸载前调用，防止防抖窗口内丢数据）*/
export function flushConvs() {
  if (_convsSaveTimer === null) return;
  clearTimeout(_convsSaveTimer);
  _convsSaveTimer = null;
  writeConvs();
}

/**
 * 订阅「别的窗口改了会话列表」。storage 事件只在**其他**窗口写入时触发，本窗不靠它保证
 * 正确性（正确性由 mutateConvs 的读改写保证），只用它立刻刷新视图。
 * @param {() => void} fn
 * @returns {() => void} 退订
 */
export function onConvsChange(fn) {
  _changeListeners.add(fn);
  return () => _changeListeners.delete(fn);
}

function handleStorage(e) {
  if (e.key !== CONV_KEY && e.key !== null) return; // key 为 null = 整库被 clear()
  if (_convsSaveTimer !== null) {
    settlePending(); // 有没落盘的改动：合并而不是作废镜像，否则刚发的消息会被外部内容吞掉
  } else {
    _convsCache = null; // 作废镜像：下一次读会重新解析外部数据
    _convsRaw = null;
  }
  for (const fn of _changeListeners) {
    try {
      fn();
    } catch (err) {
      console.warn('[conv-store] 会话变更回调异常:', err);
    }
  }
}

/** 注册 storage 监听。默认当前 window；jsdom 单测里 window 晚于模块求值才存在，
 *  故提供显式绑定入口（对同一个 window 幂等）。 */
export function bindConvsCrossWindow(win = typeof window !== 'undefined' ? window : null) {
  if (!win || typeof win.addEventListener !== 'function' || win === _boundWin) return false;
  _boundWin = win;
  win.addEventListener('storage', handleStorage);
  return true;
}

bindConvsCrossWindow();

export function convPushMessage(convId, role, text) {
  let idx = -1;
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c) return false;
    idx = c.messages.length;
    c.messages.push({ role, text });
    c.updatedAt = Date.now();
  });
  return idx;
}
export function convSetMessage(convId, index, text) {
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c || !c.messages[index]) return false;
    c.messages[index].text = text;
    c.updatedAt = Date.now();
  });
}
export function convSetSession(convId, sid) {
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c) return false;
    c.session = sid;
  });
}
/** 未发送的输入框草稿（HTML 快照，保留附件 chip）。
 *  不动 updatedAt：纯 UI 状态变更不该改左栏排序（同 chat.js persistPrefsToConv 的取舍）。
 *  老会话记录读出 undefined 即「无草稿」，无需 schema 迁移。 */
export function convSetDraft(convId, html) {
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c) return false;
    if (!html && !c.draft) return false; // 空→空：不写，免得空输入框的切换也刷一次 localStorage
    c.draft = html || '';
  });
}
/** 最近一次模型步用量（顶栏「上下文使用率」的数据源：切会话、刷新后仍要显示）。
 *  刻意**不动 updatedAt**（同 convSetDraft 的取舍）：它每个模型步都可能写一次，
 *  动了就会让左栏按更新时间排序的列表被运行中的会话反复顶到最前。 */
export function convSetContextUsage(convId, usage) {
  if (!usage || typeof usage !== 'object') return;
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c) return false;
    c.contextUsage = usage;
  });
}
export function convSetTitle(convId, title) {
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c) return false;
    c.title = String(title || '新会话').slice(0, 60);
    c.updatedAt = Date.now();
  });
}
export function convDelete(convId) {
  mutateConvs((list) => {
    const idx = list.findIndex((x) => x.id === convId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    if (list.length > 0) {
      list[0].updatedAt = Date.now();
    }
  });
}
export function convSetMeta(convId, patch) {
  if (!patch || typeof patch !== 'object') return;
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c) return false;
    Object.assign(c.meta || (c.meta = {}), patch);
    c.updatedAt = Date.now();
  });
}
// 给某条消息打补丁字段（runId / pending 等，用于关网页后按 runId 重连）
export function convSetMsgFields(convId, index, patch) {
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c || !c.messages[index]) return false;
    Object.assign(c.messages[index], patch);
    c.updatedAt = Date.now();
  });
}
/** 存储+_bubbleMap 两侧同步搬移（DOM appendChild 由调用方执行）：消息移到会话末尾，返回新索引；失败 -1。
 *  两侧永远一起动是三方同序不变量的守护核心，禁止在调用方拆开做。 */
export function moveMessageToEnd(convId, index) {
  let newIndex = -1;
  mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c || !c.messages[index]) return false;
    const [m] = c.messages.splice(index, 1);
    c.messages.push(m);
    c.updatedAt = Date.now();
    newIndex = c.messages.length - 1;
  });
  if (newIndex < 0) return -1;
  const arr = _bubbleMap.get(convId);
  if (arr && arr[index]) {
    const [b] = arr.splice(index, 1);
    arr.push(b);
  }
  return newIndex;
}

/** 存储+_bubbleMap 两侧同步删除第 index 条消息（DOM removeChild 由调用方执行）；成功返回 true。
 *  与 moveMessageToEnd 同为三方同序不变量的守护操作，禁止在调用方拆开做。 */
export function removeMessageAt(convId, index) {
  const done = mutateConvs((list) => {
    const c = list.find((x) => x.id === convId);
    if (!c || !c.messages[index]) return false;
    c.messages.splice(index, 1);
    c.updatedAt = Date.now();
  }) !== null;
  if (!done) return false;
  const arr = _bubbleMap.get(convId);
  if (arr && index < arr.length) arr.splice(index, 1);
  return true;
}

/** 重置某会话的气泡缓存（切会话/重建消息区前调用） */
export function bubbleReset(convId) { _bubbleMap.delete(convId); }
/** 登记一个新气泡（与存储 push 同步调用，保持索引对齐） */
export function bubblePush(convId, el) {
  if (!_bubbleMap.has(convId)) _bubbleMap.set(convId, []);
  _bubbleMap.get(convId).push(el);
}
/** O(1) 取某会话第 index 个气泡；未命中 null（调用方自行降级线性扫描） */
export function bubbleGet(convId, index) {
  const arr = _bubbleMap.get(convId);
  return (arr && arr[index]) || null;
}
