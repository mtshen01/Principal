/**
 * 同事监管面板「发消息」的 DOM 回归测试（2026-10-15：需求页右栏的「开发人员」收成纯指派入口，
 * 对话能力并到顶栏「同事」面板）。
 *
 * 为什么必须真跑 DOM：这一版新增的是一条**回话链路**，服务端全绿、静态检查也看不出问题，
 * 但整条交互可以是死的 —— 下拉没填选项、选了需求发出去还是别人那条、轮询每 10s 把用户
 * 正在打的字清掉、失败后按钮一直灰着，都只有驱动一遍才暴露。
 *
 * 盯死的几件事：
 * 1. 候选 = 该同事**被指派**的需求（发送端点就是这么校验的，前端不能自己另算一份）；
 * 1b. 候选只列**进行中**的需求（2026-10-16）：归档/废弃的不给选，唯一候选默认选中，
 *     全被筛掉时提示要说清「都已归档」而不是「没被指派」（后者是假话）；
 * 2. 没选人时输入区藏着；没 open_id / 没需求时禁用并说清原因（不是笼统地灰掉）；
 * 3. 提交真的打到 /api/req/colleague-messages/send，且 reqId / colleagueId / text 都对；
 * 4. 失败留草稿、成功清空并回执；
 * 5. Enter 发送，Shift+Enter 与输入法选词中的 Enter 都不发；
 * 6. 轮询重刷不碰输入框、不把选好的需求重置回第一条。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let doc;
let mod;
let calls; // fetch 调用流水
let toasts; // toast 流水
let sendFails; // 让发送端点回一次业务错误（失败路径）

const NOW = '2026-10-10T10:00:00.000Z';

const THREADS = [
  {
    colleagueId: 'cl_1', name: '王德志', roleLabel: '后端', feishuOpenId: 'ou_mock_1', unread: 0, hasThread: true, lastAt: NOW, lastText: '接口文档给你',
    reqs: [{ id: 'r_1', title: '用餐提醒' }, { id: 'r_2', title: '会员汇总' }],
  },
  { colleagueId: 'cl_2', name: '李四', roleLabel: '前端', feishuOpenId: '', hasThread: false, lastAt: null, lastText: '', unread: 0, reqs: [{ id: 'r_2', title: '会员汇总' }] },
  { colleagueId: 'cl_3', name: '赵六', roleLabel: '测试', feishuOpenId: 'ou_mock_3', hasThread: false, lastAt: null, lastText: '', unread: 0, reqs: [] },
  // cl_4 / cl_5 专供「进行中才可选」的回归：一个混着归档，一个全是终态需求
  {
    colleagueId: 'cl_4', name: '钱七', roleLabel: '后端', feishuOpenId: 'ou_mock_4', hasThread: false, lastAt: null, lastText: '', unread: 0,
    reqs: [{ id: 'r_dev', title: '进行中的需求', phase: 'dev' }, { id: 'r_old', title: '已归档的需求', phase: 'archived' }],
  },
  {
    colleagueId: 'cl_5', name: '孙八', roleLabel: '测试', feishuOpenId: 'ou_mock_5', hasThread: false, lastAt: null, lastText: '', unread: 0,
    reqs: [{ id: 'r_dead', title: '已废弃的需求', phase: 'discarded' }],
  },
];

const ok = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  // 真 index.html 当骨架（本模块的面板 DOM 就写在那里），去掉外链脚本
  const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/' });
  doc = dom.window.document;
  globalThis.window = dom.window;
  globalThis.document = doc;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.File = dom.window.File;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.EventSource = class { addEventListener() {} close() {} };
  globalThis.alert = () => {};

  toasts = { success: [], error: [] };
  dom.window.toast = {
    success: (m) => toasts.success.push(m),
    error: (m) => toasts.error.push(m),
    info: () => {},
  };

  calls = [];
  sendFails = false;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://localhost');
    let body = null;
    try {
      body = opts.body ? JSON.parse(opts.body) : null;
    } catch {
      body = null; // 本模块不发非 JSON 请求
    }
    calls.push({ url: u.pathname + u.search, method: opts.method || 'GET', body });
    if (u.pathname === '/api/req/colleague-threads') return ok({ threads: THREADS });
    if (u.pathname === '/api/req/colleague-thread') {
      const id = u.searchParams.get('colleagueId');
      const t = THREADS.find((x) => x.colleagueId === id);
      return ok({ colleague: { id, name: t.name, role: t.roleLabel, feishuOpenId: t.feishuOpenId }, messages: [], reqTitles: {} });
    }
    if (u.pathname === '/api/req/agent-actions') return ok({ actions: [] });
    if (u.pathname === '/api/req/colleague-messages/send') {
      if (sendFails) return { ok: false, status: 400, json: async () => ({ error: '该同事未填飞书 open_id，无法发送' }) };
      return ok({ ok: true, message: { id: 'cm_sent' } });
    }
    return ok({});
  };

  mod = await import('./colleague-supervisor.js');
});

after(() => {
  mod?.disposeColleagueSupervisor(); // 别把 10s 轮询留给进程
  dom?.window?.close();
});

const sentCalls = () => calls.filter((c) => c.url === '/api/req/colleague-messages/send');

/** 选中列表第 i 个人，等一轮刷新落定 */
async function selectRow(i) {
  doc.querySelectorAll('#csList .cc-row')[i].click();
  await wait();
}

/** 提交一次表单（等同点「发送」按钮） */
function submitCompose() {
  doc.getElementById('csCompose').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

test('没选人时输入区藏着；选中后候选 = 该同事被指派的需求，默认选第一条', async () => {
  mod.initColleagueSupervisor();
  await wait();
  const form = doc.getElementById('csCompose');
  assert.equal(form.hidden, true, '不知道发给谁时不该露出输入框');

  await selectRow(0);
  assert.equal(form.hidden, false);
  const sel = doc.getElementById('csReqSelect');
  assert.deepEqual(Array.from(sel.options).map((o) => o.value), ['r_1', 'r_2']);
  assert.deepEqual(Array.from(sel.options).map((o) => o.textContent), ['用餐提醒', '会员汇总'], '下拉显示需求标题');
  assert.equal(sel.value, 'r_1', '默认选最近更新的那条（列表端点已按 updatedAt 倒序）');
  assert.equal(doc.getElementById('csSendBtn').disabled, false);
  assert.equal(doc.getElementById('csComposeHint').textContent, '', '可发时不该挂提示');
  mod.disposeColleagueSupervisor();
});

test('没填 open_id / 没被指派需求：禁用输入并说明原因（不是笼统地灰掉）', async () => {
  mod.initColleagueSupervisor();
  await wait();

  await selectRow(1); // 李四：没填 open_id
  assert.equal(doc.getElementById('csSendBtn').disabled, true);
  assert.equal(doc.getElementById('csInput').disabled, true);
  assert.match(doc.getElementById('csComposeHint').textContent, /未填飞书 open_id/);

  await selectRow(2); // 赵六：没有任何需求指派给他
  assert.equal(doc.getElementById('csSendBtn').disabled, true);
  assert.match(doc.getElementById('csComposeHint').textContent, /没有被指派到任何需求/);

  mod.disposeColleagueSupervisor();
});

test('归属候选只列进行中的需求：归档的不进下拉，唯一候选默认选中', async () => {
  mod.initColleagueSupervisor();
  await wait();

  await selectRow(3); // 钱七：一条 dev + 一条 archived
  const sel = doc.getElementById('csReqSelect');
  assert.deepEqual(Array.from(sel.options).map((o) => o.value), ['r_dev'], '归档的需求不给选');
  assert.equal(sel.value, 'r_dev', '唯一的进行中需求默认就选中（不用用户动手）');
  assert.equal(doc.getElementById('csSendBtn').disabled, false);
  assert.equal(doc.getElementById('csComposeHint').textContent, '', '有可选项时不该挂提示');

  mod.disposeColleagueSupervisor();
});

test('候选全被筛掉（只有废弃/归档）：禁用，且说清是「都已归档」而不是「没被指派」', async () => {
  mod.initColleagueSupervisor();
  await wait();

  await selectRow(4); // 孙八：只有一条 discarded
  const sel = doc.getElementById('csReqSelect');
  assert.deepEqual(Array.from(sel.options).map((o) => o.value), [], '终态需求一条都不进下拉');
  assert.equal(sel.disabled, true);
  assert.equal(doc.getElementById('csInput').disabled, true);
  assert.equal(doc.getElementById('csSendBtn').disabled, true);
  assert.match(doc.getElementById('csComposeHint').textContent, /都已归档/, '不能说是「没被指派」（那是假话）');

  mod.disposeColleagueSupervisor();
});

test('发送：POST 带 reqId/colleagueId/text；失败留草稿，成功清空并回执', async () => {
  mod.initColleagueSupervisor();
  await wait();
  await selectRow(0);
  const input = doc.getElementById('csInput');

  sendFails = true;
  input.value = '接口文档收到，今天改完';
  submitCompose();
  await wait();

  const first = sentCalls().at(-1);
  assert.ok(first, '应打到发送端点');
  assert.equal(first.method, 'POST');
  assert.deepEqual(first.body, { reqId: 'r_1', colleagueId: 'cl_1', text: '接口文档收到，今天改完' });
  assert.equal(input.value, '接口文档收到，今天改完', '失败要留下草稿：多数失败（未启用机器人 / 没 open_id）改完能直接重发');
  assert.equal(doc.getElementById('csSendBtn').disabled, false, '失败后按钮得恢复可点，灰着会像卡死');
  assert.ok(toasts.error.some((m) => m.includes('open_id')), '服务端文案要原样透出');

  sendFails = false;
  toasts.success.length = 0;
  submitCompose();
  await wait();
  assert.equal(input.value, '', '成功后清空输入');
  assert.ok(toasts.success.some((m) => m.includes('王德志')), '给一条「已发送」的回执');
  mod.disposeColleagueSupervisor();
});

test('发送：选中的那条需求跟着请求走（不是永远发第一条）', async () => {
  mod.initColleagueSupervisor();
  await wait();
  await selectRow(0);

  doc.getElementById('csReqSelect').value = 'r_2';
  doc.getElementById('csInput').value = '这条归会员汇总';
  submitCompose();
  await wait();

  assert.equal(sentCalls().at(-1).body.reqId, 'r_2', 'reqId 必须是用户选的那条');
  mod.disposeColleagueSupervisor();
});

test('Enter 发送；Shift+Enter 与输入法选词中的 Enter 都不发', async () => {
  mod.initColleagueSupervisor();
  await wait();
  await selectRow(0);
  const input = doc.getElementById('csInput');
  const before = sentCalls().length;

  input.value = '换行草稿';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  await wait(10);
  assert.equal(sentCalls().length, before, 'Shift+Enter 只换行');

  // jsdom 的 KeyboardEventInit 对 isComposing 的支持不稳，直接把该属性钉在事件对象上
  const composing = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(composing, 'isComposing', { value: true });
  input.dispatchEvent(composing);
  await wait(10);
  assert.equal(sentCalls().length, before, '中文输入法选词的 Enter 不算发送');

  input.value = '这条要发出去';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait();
  assert.equal(sentCalls().length, before + 1, 'Enter 应发送');
  assert.equal(sentCalls().at(-1).body.text, '这条要发出去');
  assert.equal(input.value, '');
  mod.disposeColleagueSupervisor();
});

test('轮询重刷：不碰正在输入的草稿，也不把选好的需求重置回第一条', async () => {
  mod.initColleagueSupervisor();
  await wait();
  await selectRow(0);

  doc.getElementById('csReqSelect').value = 'r_2';
  const input = doc.getElementById('csInput');
  input.value = '草稿：正在输入';

  mod.initColleagueSupervisor(); // 再进一次视图 = 立刻跑一轮 poll（列表 + 详情都重刷）
  await wait();

  assert.equal(input.value, '草稿：正在输入', '轮询不得清掉用户的输入');
  assert.equal(doc.getElementById('csReqSelect').value, 'r_2', '轮询不得把选好的需求重置回第一条');
  assert.equal(doc.getElementById('csSendBtn').disabled, false, '重刷后仍应可发');
  mod.disposeColleagueSupervisor();
});
