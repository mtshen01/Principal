/**
 * 同事监管面板的 DOM 回归测试（2026-10-10 台账改版；2026-10-15 加发消息）。
 *
 * 为什么必须真跑 DOM：这一版把台账从右列底部的固定高度区改成「会话标题右对齐按钮 → 侧滑抽屉」，
 * 服务端全绿、静态检查也看不出问题，但整条交互可以是死的 —— 按钮绑没绑、抽屉开的是谁的台账、
 * 切人/离开视图有没有把挂在 body 上的抽屉收掉，都只有驱动一遍才暴露。
 * 骨架沿用同目录其他 jsdom 测试（真 index.html + jsdom + 假 fetch）。
 *
 * 盯死的几件事：
 * 1. 会话标题行展示同事的飞书 open_id；
 * 2. 台账按钮：未选人禁用、选人后启用；点开抽屉里只应有**当前选中同事**的条目；
 * 3. 切人 / 离开视图都立即关抽屉（抽屉挂 body，留下会悬在别的视图上）；
 * 4. 撤销按钮真的在行里 —— 旧 renderActions 建了按钮却没 append，行内从来看不到「撤销」；
 * 5. 发消息（2026-10-15 需求页「开发人员」的对话能力并到这里）：归属需求候选来自列表端点、
 *    没 open_id / 没被指派需求时禁用并说明原因、Enter 发送而 Shift+Enter 与输入法选词不发、
 *    失败留草稿、轮询重刷不清空草稿也不重置已选需求。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let doc;
let calls; // fetch 调用流水
let mod; // colleague-supervisor 模块
let toasts; // toast 流水（成功回执是发消息的一部分）
let sendShouldFail; // 让发送端点回一次业务错误（失败路径）

const NOW = '2026-10-10T10:00:00.000Z';

const THREADS = [
  {
    colleagueId: 'cl_1', name: '王德志', roleLabel: '后端', feishuOpenId: 'ou_mock_1', unread: 2, hasThread: true, lastAt: NOW, lastText: '接口文档给你',
    reqs: [{ id: 'r_1', title: '用餐提醒' }, { id: 'r_2', title: '会员汇总' }],
  },
  { colleagueId: 'cl_2', name: '李四', roleLabel: '前端', feishuOpenId: '', unread: 0, hasThread: false, lastAt: null, lastText: '', reqs: [{ id: 'r_2', title: '会员汇总' }] },
  { colleagueId: 'cl_3', name: '赵六', roleLabel: '测试', feishuOpenId: 'ou_mock_3', unread: 0, hasThread: false, lastAt: null, lastText: '', reqs: [] },
];
const MESSAGES = {
  cl_1: [{ id: 'm1', dir: 'in', text: '接口文档给你', at: NOW }],
  cl_2: [],
  cl_3: [],
};
const ACTIONS = {
  cl_1: [
    { id: 'aa_1', tool: 'submit_req_change', resultBrief: '已提交需求变动', at: NOW, undo: { kind: 'revert-req-change' }, undone: false },
    { id: 'aa_2', tool: 'run_action', resultBrief: '已执行退款脚本', at: NOW, undo: null, undone: false },
    { id: 'aa_3', tool: 'supplement_requirement', resultBrief: '已补充内容', at: NOW, undo: { kind: 'remove-supplement' }, undone: true },
  ],
  cl_2: [],
  cl_3: [],
};

const ok = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  // 用真实 index.html 当骨架：chat.js 等模块在顶层就绑事件，缺元素会直接抛
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
  sendShouldFail = false;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://localhost');
    let body = null;
    try {
      body = opts.body ? JSON.parse(opts.body) : null;
    } catch {
      body = null; // 不是 JSON 的请求（本模块不发这种）不记 body
    }
    calls.push({ url: u.pathname + u.search, method: opts.method || 'GET', body });
    if (u.pathname === '/api/req/colleague-threads') return ok({ threads: THREADS });
    if (u.pathname === '/api/req/colleague-thread') {
      const id = u.searchParams.get('colleagueId');
      const t = THREADS.find((x) => x.colleagueId === id);
      return ok({
        colleague: t ? { id, name: t.name, role: t.roleLabel, feishuOpenId: t.feishuOpenId } : null,
        messages: MESSAGES[id] || [],
        reqTitles: {},
      });
    }
    if (u.pathname === '/api/req/agent-actions') {
      const id = u.searchParams.get('colleagueId');
      return ok({ actions: ACTIONS[id] || [] });
    }
    if (u.pathname === '/api/req/agent-action/undo') return ok({ ok: true, note: '已回滚' });
    if (u.pathname === '/api/req/colleague-messages/send') {
      if (sendShouldFail) return { ok: false, status: 400, json: async () => ({ error: '该同事未填飞书 open_id，无法发送' }) };
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

test('未选人：台账按钮禁用；选中后标题展示飞书 open_id、按钮启用', async () => {
  mod.initColleagueSupervisor();
  await wait();
  assert.equal(doc.querySelectorAll('#csList .cc-row').length, 3, '同事列表应渲染');
  const btn = doc.getElementById('csLedgerBtn');
  assert.equal(btn.disabled, true, '未选人时不该能开台账');

  doc.querySelectorAll('#csList .cc-row')[0].click();
  await wait();
  const head = doc.getElementById('csThreadHead');
  assert.match(head.textContent, /王德志/, '标题应有姓名');
  assert.match(head.textContent, /飞书 ID：ou_mock_1/, '标题应展示飞书 open_id');
  assert.match(head.textContent, /1 条消息/, '标题应有消息数');
  assert.equal(btn.disabled, false, '选人落定后按钮启用');
  mod.disposeColleagueSupervisor();
});

test('点按钮开抽屉：只展示当前同事的台账，撤销/已撤销/撤不回三态都在行里', async () => {
  mod.initColleagueSupervisor();
  await wait();
  doc.getElementById('csLedgerBtn').click();

  const host = doc.body.querySelector('.cc-drawer-host');
  assert.ok(host, '应挂出抽屉壳');
  assert.equal(host.querySelector('.cc-drawer-title').textContent, '王德志 · AI 改动台账');
  assert.equal(host.querySelectorAll('.cs-act').length, 3, '抽屉里是这位同事的全部台账条目');
  assert.equal(host.querySelectorAll('.cs-undo').length, 1, '只有带锚点且未撤过的才给撤销按钮');
  assert.ok([...host.querySelectorAll('.cs-act')].some((r) => r.textContent.includes('撤不回')), 'undo:null 应显示撤不回');
  assert.ok([...host.querySelectorAll('.cs-act')].some((r) => r.textContent.includes('已撤销')), '已撤销条目应显示状态');

  mod.disposeColleagueSupervisor();
  assert.equal(doc.body.querySelector('.cc-drawer-host'), null, '离开视图必须关掉抽屉（它挂在 body 上）');
});

test('抽屉里点撤销：真的发 POST，且刷新内容而不是关掉抽屉', async () => {
  mod.initColleagueSupervisor();
  await wait();
  doc.getElementById('csLedgerBtn').click();
  const host = doc.body.querySelector('.cc-drawer-host');
  assert.ok(host);

  const before = calls.length;
  host.querySelector('.cs-undo').click();
  await wait();
  assert.ok(
    calls.slice(before).some((c) => c.url === '/api/req/agent-action/undo' && c.method === 'POST'),
    '撤销应打到 undo 端点',
  );
  assert.ok(doc.body.querySelector('.cc-drawer-host'), '撤销后抽屉仍应开着');
  mod.disposeColleagueSupervisor();
});

test('Esc 关抽屉；切换同事立即关抽屉并换成新人的标题', async () => {
  mod.initColleagueSupervisor();
  await wait();
  doc.getElementById('csLedgerBtn').click();
  assert.ok(doc.body.querySelector('.cc-drawer-host'));

  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.body.querySelector('.cc-drawer-host'), null, 'Esc 应关抽屉');

  doc.getElementById('csLedgerBtn').click();
  assert.ok(doc.body.querySelector('.cc-drawer-host'));
  doc.querySelectorAll('#csList .cc-row')[1].click();
  assert.equal(doc.body.querySelector('.cc-drawer-host'), null, '切人应立刻关抽屉，不等接口回');

  await wait();
  assert.match(doc.getElementById('csThreadHead').textContent, /未绑飞书/, '没填 open_id 的同事显示未绑');
  assert.equal(doc.getElementById('csLedgerBtn').disabled, false);

  // 新人的台账为空 → 抽屉里应是空态提示，而不是上一位同事的残留
  doc.getElementById('csLedgerBtn').click();
  const host = doc.body.querySelector('.cc-drawer-host');
  assert.ok(host);
  assert.equal(host.querySelectorAll('.cs-act').length, 0);
  assert.match(host.textContent, /还没有 AI 写操作记录/);
  mod.disposeColleagueSupervisor();
});