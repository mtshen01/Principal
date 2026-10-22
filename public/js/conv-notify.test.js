/**
 * 飞书补充内容收件箱轮询 —— 认领（/claim）契约测试。
 *
 * 为什么这条必须有测试（2026-08-28 真实事故）：
 * applyInjected 的真身是 chat.js 的 applyInjectedItems，它是 **async**；而 pollInbox 曾把它
 * 当同步函数用 —— `Promise.length` 是 undefined，`if (!applied.length) return` 于是永远提前
 * return，/claim 一次都不发。后果远不止「少认领一次」：条目永远留在服务端收件箱里，5 秒一轮
 * 的轮询把同一条补充内容反复上屏，用户看到的是「自己最后那句话被无限自动重发」；而助手气泡
 * 接的是注入那一刻的 runId，隔天进程早已重启、run 不存在，气泡永久停在「运行中…」。
 *
 * 两条断言互为反面，缺一不可：
 *  - 上了屏必须认领（否则重复上屏）
 *  - 没上屏绝不认领（认领即从服务端删除，这条补充内容会永久蒸发）
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadConvs, saveConvs, flushConvs } from './conv-store.js';

const CONV_ID = 'c_test_inbox';

let dom;
let calls; // 本轮记录到的 fetch 调用：{url, body}
let inboxItems; // /inbox 要返回的条目
let appliedResult; // applyInjected 的返回值（真身 async，这里也必须 async）
let curId; // getCurrentConvId 的实时返回（可变：新会话用例把它置 null）
let onResponse; // /api/conv-notify/on 的应答体（用例可换，默认 ok:true）

before(async () => {
  dom = new JSDOM(
    '<!doctype html><html><body><button class="bar-icon" id="notifyBtn" aria-pressed="false">🔔</button></body></html>',
    { url: 'http://localhost/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  // conv-store 的 _convsCache 是模块级的、首次 loadConvs 即定型 —— 必须在任何调用前种好数据
  localStorage.setItem(
    'claude_convs',
    JSON.stringify([{ id: CONV_ID, title: 't', messages: [], meta: { notifyFeishu: true } }]),
  );
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
    if (u.startsWith('/api/conv-notify/inbox')) {
      return { ok: true, json: async () => ({ active: true, items: inboxItems }) };
    }
    if (u.startsWith('/api/conv-notify/on')) {
      return { ok: true, json: async () => onResponse };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { bindConvNotify } = await import('./conv-notify.js');
  // 只 bind 一次：每次 bind 都会新建一份闭包定时器，重复 bind 会漏掉旧的那个
  bindConvNotify({
    applyInjected: async () => appliedResult, // 与 chat.js 的 applyInjectedItems 同为 async
    getCurrentConvId: () => curId,
  });
});

after(() => {
  // 停掉 5s 轮询：切到一个本地没有记录的会话即触发 stopPolling，否则 node --test 不退出
  window.__convNotify?.onConvOpened('__no_such_conv__');
  flushConvs(); // 把防抖中的 saveConvs 落盘，避免定时器在 localStorage 被删后才触发（噪音告警）
  dom?.window?.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.fetch;
});

beforeEach(() => {
  calls = [];
  onResponse = { ok: true };
  // 复位会话与待生效态（onConvOpened(null) 会重置 pendingNewConv 并停掉上一用例的轮询）
  window.__convNotify.onConvOpened(null);
  const list = loadConvs();
  list.length = 0;
  list.push({ id: CONV_ID, title: 't', messages: [], meta: { notifyFeishu: true } });
  saveConvs(list);
  curId = CONV_ID;
});

/** 等 pollInbox 的两段 await（fetch + applyInjected）落地 */
const settle = () => new Promise((r) => setTimeout(r, 20));

test('条目上屏后必须 /claim 认领（applyInjected 是 async，不能当同步函数用）', async () => {
  inboxItems = [{ id: 'inj_1', text: '继续', runId: 'run_dead' }];
  appliedResult = ['inj_1'];

  window.__convNotify.onConvOpened(CONV_ID); // 内部立刻 pollInbox 一次
  await settle();

  const claim = calls.find((c) => c.url.includes('/api/conv-notify/claim'));
  assert.ok(claim, '已上屏却没发 /claim：条目留在服务端收件箱，下一轮会把同一条补充内容再上一次屏');
  assert.deepEqual(claim.body, { convId: CONV_ID, ids: ['inj_1'] });
});

test('一条都没上屏 → 绝不认领（认领即删除，这条补充内容会永久蒸发）', async () => {
  inboxItems = [{ id: 'inj_2', text: '再补一句', runId: 'run_dead' }];
  appliedResult = [];

  window.__convNotify.onConvOpened(CONV_ID);
  await settle();

  assert.equal(
    calls.some((c) => c.url.includes('/api/conv-notify/claim')),
    false,
    '没上屏就认领 = 服务端把条目删了、用户永远看不到这条补充内容',
  );
});

// ---- 新会话（尚无 conv 记录）的「待生效」语义 ----
// 背景（2026-10-10 用户反馈）：新会话里点通知开关被「请先发一条消息」挡住。现在改为：
// 点击先记待生效（只亮按钮、不调服务端——快照缺 cwd/session）；首条消息落库后 chat.js 调
// onConvCreated 补登记。两条不变量：① 没有 conv 记录绝不调 /on；② 补登记被拒（ok:false）
// 绝不写 meta、绝不点亮——与在已建会话里点的失败语义一致。

const notifyBtn = () => document.getElementById('notifyBtn');
const isBtnOn = () => notifyBtn().getAttribute('aria-pressed') === 'true';
const clickToggle = () => notifyBtn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const findOnCall = () => calls.find((c) => c.url.includes('/api/conv-notify/on'));
const toastText = () => [...document.querySelectorAll('#toast-container .toast-msg')].map((e) => e.textContent).join(' | ');
/** 模拟 chat.js 的 recordMessage：新会话记录（含首条用户消息带来的标题/cwd 等快照字段） */
function seedNewConv(id, { title = '你好', cwd = 'D:/proj' } = {}) {
  const list = loadConvs();
  list.push({
    id,
    title,
    session: null,
    cwd,
    messages: [{ role: 'user', text: title }],
    model: 'auto',
    effort: 'medium',
    mode: 'default',
    updatedAt: Date.now(),
  });
  saveConvs(list);
  return list.find((c) => c.id === id);
}

test('新会话：点开关先亮「待生效」且不调 /on；再点取消', async () => {
  curId = null; // 新会话：没有 conv 记录、没有 currentConvId
  clickToggle();
  await settle();
  assert.equal(isBtnOn(), true, '新会话里点开关应点亮（待生效）');
  assert.equal(findOnCall(), undefined, '还没有 conv 记录：不得调 /on（快照缺 cwd/session，登记了也白登记）');
  assert.match(toastText(), /首条消息/, '应说清「发送首条消息后生效」的时序');

  clickToggle();
  await settle();
  assert.equal(isBtnOn(), false, '再点一下应取消待生效');
  assert.equal(findOnCall(), undefined);
});

test('待生效 → 首条消息落库后补登记：写 meta + /on 带完整快照 + 按钮保持点亮', async () => {
  curId = null;
  clickToggle();
  await settle();
  assert.equal(isBtnOn(), true);

  const c = seedNewConv('c_new');
  curId = 'c_new'; // chat.js 在 recordMessage 前已把 currentConvId 指到新记录
  window.__convNotify.onConvCreated('c_new');
  await settle();

  const onCall = findOnCall();
  assert.ok(onCall, '首条消息落库后必须补调 /on');
  assert.equal(onCall.body.convId, 'c_new');
  assert.equal(onCall.body.title, '你好', '快照应带首条消息生成的标题');
  assert.equal(onCall.body.cwd, 'D:/proj', '快照应带 cwd —— 飞书侧 resume 回原会话靠它');
  assert.equal(c.meta?.notifyFeishu, true, '补登记成功必须写 meta.notifyFeishu');
  assert.equal(isBtnOn(), true, '当前就在该会话，按钮应保持点亮');
});

test('补登记被拒（ok:false）：不写 meta、灭灯、弹服务端指路文案', async () => {
  onResponse = { ok: false, error: '请先到设置页填写「我的飞书 open_id」' };
  curId = null;
  clickToggle();
  await settle();
  assert.equal(isBtnOn(), true, '客户端此刻不知道配置缺失，点击先乐观点亮');

  const c = seedNewConv('c_new2');
  curId = 'c_new2';
  window.__convNotify.onConvCreated('c_new2');
  await settle();

  assert.ok(!c.meta?.notifyFeishu, 'ok:false 绝不能写 meta —— 写了用户会以为通知已生效');
  assert.equal(isBtnOn(), false, '被拒后待生效的亮灯必须收干净');
  assert.match(toastText(), /open_id/, '应透传服务端的可执行指路文案');
});

test('onConvCreated 无待生效态：no-op（普通会话发送不误触发登记）', async () => {
  window.__convNotify.onConvCreated(CONV_ID);
  await settle();
  assert.equal(findOnCall(), undefined, '没点过待生效开关的会话，onConvCreated 不得补登记');
});
