import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReqWriteTools, REQ_WRITE_TOOL_NAMES } from './req-write.js';
// 注入真实 mergeFigmas（纯函数）—— 替身会让「合并语义」这一层拒真
import { mergeFigmas } from '../../../entrypoints/web/req-map.logic.js';

const REQ_DEV = {
  id: 'r_a1', title: '订单改版', phase: 'dev', assignees: ['cl_1'],
  projects: { frontend: { dir: 'D:/fe' } },
  apiDocs: [], branches: [{ dir: 'D:/fe', branch: 'feat/order', baseBranch: 'main' }],
  changes: [], supplements: [], reqDoc: { name: 'req.md' },
  reqMap: { versions: [{ v: 1, path: 'D:/map1.json' }] },
};
const REQ_TEST = { ...REQ_DEV, id: 'r_t1', phase: 'test' };
const REQ_REVIEW = {
  id: 'r_v1', title: '新需求', phase: 'review', assignees: ['cl_1'],
  projects: { frontend: { dir: 'D:/fe' } }, reqDoc: { name: 'req.md' },
  apiDocs: [], changes: [], supplements: [], branches: [],
};

function deps(extra = {}) {
  return {
    getRequirement: (id) => ({ r_a1: REQ_DEV, r_t1: REQ_TEST, r_v1: REQ_REVIEW })[id] || null,
    registerApiDoc: () => ({ ok: true, doc: { id: 'd1', name: 'order.md' } }),
    enqueueSystemTask: () => ({ ok: true }),
    updateRequirement: () => {},
    readMapVersion: async () => null,
    writeMapVersion: async () => 1,
    mergeFigmas,
    ...extra,
  };
}
const pick = (tools, name) => tools.find((t) => t.name === name);

test('REQ_WRITE_TOOL_NAMES：P2 两个 + P4 三个，且与实际装配一致', () => {
  assert.deepEqual(REQ_WRITE_TOOL_NAMES, [
    'register_api_doc', 'start_dev_task', 'submit_req_change', 'supplement_requirement', 'upload_design_ref',
  ]);
  assert.deepEqual(buildReqWriteTools(deps()).map((t) => t.name), REQ_WRITE_TOOL_NAMES);
});

test('全部工具都是 reversible，且 buildUndo 必须是函数（注册期不变式）', () => {
  for (const t of buildReqWriteTools(deps())) {
    assert.equal(t.danger, 'reversible', t.name);
    assert.equal(typeof t.buildUndo, 'function', t.name);
  }
});

// 台账写入的两种模式必须分清楚（P4 通用写入器落地时定）：register_api_doc 的锚点在调用点就有，
// 由 wrapper 即时写；start_dev_task 的锚点（分支/mergeSha）要等 run 收尾才有，必须 selfLedger，
// 否则「无代码改动 / run 失败」的任务会留下撤不出任何东西的假骨架（判据见 req-write.js 文件头）。
test('台账模式：start_dev_task 自持（selfLedger），register_api_doc 由 wrapper 即时写', () => {
  const tools = buildReqWriteTools(deps());
  assert.equal(pick(tools, 'start_dev_task').selfLedger, true);
  assert.notEqual(pick(tools, 'register_api_doc').selfLedger, true);
});

test('register_api_doc：只对 backend 可见', () => {
  assert.deepEqual(pick(buildReqWriteTools(deps()), 'register_api_doc').roles, ['backend']);
});

test('start_dev_task：backend / product / qa 可见', () => {
  assert.deepEqual(pick(buildReqWriteTools(deps()), 'start_dev_task').roles.slice().sort(), ['backend', 'product', 'qa']);
});

test('两个工具：非参与人一律拒绝（fail-closed）', async () => {
  for (const t of buildReqWriteTools(deps())) {
    const out = await t.handler({ reqId: 'r_a1', name: 'a.md', path: 'D:/a.md', task: 'x' }, { colleagueId: 'cl_9', msgId: 'm1' });
    assert.ok(out.error, t.name);
  }
});

test('两个工具：缺 colleagueId 一律拒绝（不外推成全部可见）', async () => {
  for (const t of buildReqWriteTools(deps())) {
    const out = await t.handler({ reqId: 'r_a1', name: 'a.md', path: 'D:/a.md', task: 'x' }, {});
    assert.ok(out.error, t.name);
  }
});

test('相位边界：各工具只在自己的相位可用，且给人话而不是内部状态码', async () => {
  const tools = buildReqWriteTools(deps());
  const ctx = { colleagueId: 'cl_1', msgId: 'm1' };
  // 文档登记 / 起开发任务：仅开发期
  for (const name of ['register_api_doc', 'start_dev_task']) {
    const out = await pick(tools, name).handler({ reqId: 'r_t1', name: 'a.md', task: 'x' }, ctx);
    assert.match(out.error, /开发期/, name);
  }
  // 需求变动：仅开发/测试期（评审期拒绝）
  const changeOut = await pick(tools, 'submit_req_change').handler({ reqId: 'r_v1', text: 'x' }, ctx);
  assert.match(changeOut.error, /开发\/测试期/);
  // 补充说明：仅评审期（开发期拒绝）
  const supOut = await pick(tools, 'supplement_requirement').handler({ reqId: 'r_a1', text: 'x' }, ctx);
  assert.match(supOut.error, /评审期/);
});

// 路径不再经 input 传入（模型只知道文件名，见 session.js 的 fileLine 注释）——
// 真实路径经 ctx.files 由服务端按文件名反查，测试也照这个契约喂 ctx。
test('register_api_doc：成功返回可读结果 + delete-apidoc 撤销锚点', async () => {
  const t = pick(buildReqWriteTools(deps()), 'register_api_doc');
  const input = { reqId: 'r_a1', name: 'order.md' };
  const ctx = { colleagueId: 'cl_1', msgId: 'm1', files: [{ name: 'order.md', path: 'D:/order.md' }] };
  const out = await t.handler(input, ctx);
  assert.equal(out.ok, true);
  const undo = t.buildUndo(input, out, ctx);
  assert.equal(undo.kind, 'delete-apidoc');
  assert.equal(undo.reqId, 'r_a1');
  assert.equal(undo.name, 'order.md');
});

test('register_api_doc：底层失败时如实返回不谎报 ok，但下游错误里的磁盘路径不能透给模型', async () => {
  const d = deps({ registerApiDoc: () => ({ ok: false, error: '文件不存在：D:/a.md' }) });
  const t = pick(buildReqWriteTools(d), 'register_api_doc');
  const ctx = { colleagueId: 'cl_1', msgId: 'm1', files: [{ name: 'a.md', path: 'D:/a.md' }] };
  const out = await t.handler({ reqId: 'r_a1', name: 'a.md' }, ctx);
  assert.ok(out.error);
  assert.notEqual(out.ok, true);
  assert.doesNotMatch(out.error, /D:\//, '下游错误里的磁盘路径不能透给模型');
  assert.doesNotMatch(out.error, /文件不存在/, '下游原始文案不该原样转发');
});

// 绝对路径不进模型上下文（P2+P3 跨期漏洞修复）：模型只报得出文件名，
// 报一个从没收到过的文件名时必须明确拒绝，不能拿 undefined 路径去登记。
test('register_api_doc：模型报了个没收到过的文件名 → 返回 error，不调 registerApiDoc', async () => {
  let called = false;
  const d = deps({
    registerApiDoc: () => {
      called = true;
      return { ok: true, doc: { name: 'ghost.md' } };
    },
  });
  const t = pick(buildReqWriteTools(d), 'register_api_doc');
  const ctx = { colleagueId: 'cl_1', msgId: 'm1', files: [{ name: 'order.md', path: 'D:/order.md' }] };
  const out = await t.handler({ reqId: 'r_a1', name: 'ghost.md' }, ctx);
  assert.match(out.error, /ghost\.md/);
  assert.equal(called, false, '路径解析不到就不该去登记');
});

// —— spec §6.2：归属判错会把改动落到别的需求的分支上。
// 解法不是让 agent 更小心，是让最知道答案的人当场看见。
test('start_dev_task：回复必须明写目标需求标题，供同事当场纠错', async () => {
  const t = pick(buildReqWriteTools(deps()), 'start_dev_task');
  const out = await t.handler({ reqId: 'r_a1', task: '把分页参数改成 pageNo' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.equal(out.ok, true);
  assert.match(out.reply, /订单改版/, '必须带需求标题');
  assert.match(out.reply, /r_a1|分支|feat\/order/, '必须带需求 id 或分支名');
});

test('start_dev_task：入队 payload 带 msgId / colleagueId / prompt / title / 回复路由', async () => {
  let seen = null;
  const d = deps({ enqueueSystemTask: (reqId, kind, p) => { seen = { reqId, kind, p }; return { ok: true }; } });
  const t = pick(buildReqWriteTools(d), 'start_dev_task');
  await t.handler({ reqId: 'r_a1', task: '改分页' }, { colleagueId: 'cl_1', msgId: 'm1', chatId: 'oc_g', chatType: 'group' });
  assert.equal(seen.reqId, 'r_a1');
  assert.equal(seen.kind, 'colleague-dev');
  assert.equal(seen.p.msgId, 'm1');
  assert.equal(seen.p.colleagueId, 'cl_1');
  assert.ok(seen.p.prompt.includes('改分页'), 'prompt 要带上同事说的原话');
  assert.ok(seen.p.title);
  // 2026-10-13：任务收尾时的简报要回来源会话（群里 @ 出来的回群里），路由随 payload 走到 colleague-dev
  assert.equal(seen.p.chatId, 'oc_g');
  assert.equal(seen.p.chatType, 'group');
});

// —— 真正的 mergeSha 要等 run 跑完才有，由 colleague-dev 的 onSettle 写台账。
// 工具这一刻只能给出「哪个需求、哪条消息起的任务」，供 onSettle 关联。
test('start_dev_task：buildUndo 给 revert-merge 骨架，mergeSha 留 null 待回填', async () => {
  const t = pick(buildReqWriteTools(deps()), 'start_dev_task');
  const input = { reqId: 'r_a1', task: 'x' };
  const ctx = { colleagueId: 'cl_1', msgId: 'm1' };
  const out = await t.handler(input, ctx);
  const undo = t.buildUndo(input, out, ctx);
  assert.equal(undo.kind, 'revert-merge');
  assert.equal(undo.reqId, 'r_a1');
  assert.equal(undo.mergeSha, null);
});

test('start_dev_task：入队失败时如实返回错误', async () => {
  const d = deps({ enqueueSystemTask: () => ({ ok: false, error: '需求忙' }) });
  const t = pick(buildReqWriteTools(d), 'start_dev_task');
  const out = await t.handler({ reqId: 'r_a1', task: 'x' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.ok(out.error);
  assert.notEqual(out.ok, true);
});

// ── P4：submit_req_change（登记需求变动 + 有图则入队地图更新）

test('submit_req_change：可见性/角色（仅 product）', () => {
  const t = pick(buildReqWriteTools(deps()), 'submit_req_change');
  assert.deepEqual(t.roles, ['product']);
});

test('submit_req_change：dev 期成功 → 写 changes + 入队 mapchange（有图时）', async () => {
  let saved = null;
  const queued = [];
  const d = deps({
    updateRequirement: (id, patch, event) => (saved = { id, patch, event }),
    enqueueSystemTask: (reqId, kind, p) => queued.push({ reqId, kind, p }),
  });
  const t = pick(buildReqWriteTools(d), 'submit_req_change');
  const out = await t.handler({ reqId: 'r_a1', text: '列表加一个筛选按钮' }, { colleagueId: 'cl_1', msgId: 'm1' });

  assert.equal(out.ok, true);
  assert.match(out.reply, /订单改版/);
  assert.equal(saved.patch.changes.length, 1);
  assert.equal(saved.patch.changes[0].text, '列表加一个筛选按钮');
  assert.equal(saved.patch.changes[0].scope, 'both');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'mapchange');
  assert.equal(queued[0].p.changeId, saved.patch.changes[0].id);

  const undo = t.buildUndo({ reqId: 'r_a1' }, out, {});
  assert.deepEqual(undo, { kind: 'revert-req-change', reqId: 'r_a1', changeId: out.__private.changeId });
});

test('submit_req_change：没有地图时只记录、不入队', async () => {
  const noMap = { ...REQ_DEV, reqMap: { versions: [] } };
  let queued = 0;
  const d = deps({
    getRequirement: () => noMap,
    enqueueSystemTask: () => queued++,
  });
  const t = pick(buildReqWriteTools(d), 'submit_req_change');
  const out = await t.handler({ reqId: 'r_a1', text: 'x' }, { colleagueId: 'cl_1' });
  assert.equal(out.ok, true);
  assert.equal(queued, 0);
});

test('submit_req_change：空正文拒绝，不写盘', async () => {
  let wrote = false;
  const d = deps({ updateRequirement: () => (wrote = true) });
  const t = pick(buildReqWriteTools(d), 'submit_req_change');
  const out = await t.handler({ reqId: 'r_a1', text: '   ' }, { colleagueId: 'cl_1' });
  assert.ok(out.error);
  assert.equal(wrote, false);
});

// ── P4：supplement_requirement（评审期补充说明，附件按 ctx.files 反查）

test('supplement_requirement：可见性/角色（product + design）', () => {
  const t = pick(buildReqWriteTools(deps()), 'supplement_requirement');
  assert.deepEqual(t.roles.slice().sort(), ['design', 'product']);
});

test('supplement_requirement：评审期成功 → 写 supplements + 入队 docgen 修订', async () => {
  let saved = null;
  const queued = [];
  const d = deps({
    updateRequirement: (id, patch, event) => (saved = { id, patch, event }),
    enqueueSystemTask: (reqId, kind, p) => queued.push({ reqId, kind, p }),
  });
  const t = pick(buildReqWriteTools(d), 'supplement_requirement');
  const ctx = { colleagueId: 'cl_1', msgId: 'm1', files: [{ name: 'order.md', path: 'D:/order.md' }] };
  const out = await t.handler({ reqId: 'r_v1', text: '登录态要保留 7 天', files: ['order.md'] }, ctx);

  assert.equal(out.ok, true);
  const sup = saved.patch.supplements[0];
  assert.equal(sup.text, '登录态要保留 7 天');
  assert.deepEqual(sup.files, [{ name: 'order.md', path: 'D:/order.md' }]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'docgen');
  assert.equal(queued[0].p.supplement.id, sup.id);

  const undo = t.buildUndo({ reqId: 'r_v1' }, out, {});
  assert.deepEqual(undo, { kind: 'remove-supplement', reqId: 'r_v1', supplementId: out.__private.supplementId });
});

test('supplement_requirement：模型报了个没收到过的文件名 → 拒绝，不写盘', async () => {
  let wrote = false;
  const d = deps({ updateRequirement: () => (wrote = true) });
  const t = pick(buildReqWriteTools(d), 'supplement_requirement');
  const ctx = { colleagueId: 'cl_1', files: [{ name: 'order.md', path: 'D:/order.md' }] };
  const out = await t.handler({ reqId: 'r_v1', text: 'x', files: ['ghost.md'] }, ctx);
  assert.match(out.error, /ghost\.md/);
  assert.equal(wrote, false);
});

test('supplement_requirement：正文与附件都空 → 拒绝；配置不齐时只记录不入队', async () => {
  const tools = buildReqWriteTools(deps());
  const t = pick(tools, 'supplement_requirement');
  const empty = await t.handler({ reqId: 'r_v1' }, { colleagueId: 'cl_1' });
  assert.ok(empty.error);

  const noDoc = { ...REQ_REVIEW, reqDoc: null };
  let queued = 0;
  const d2 = deps({ getRequirement: () => noDoc, enqueueSystemTask: () => queued++ });
  const t2 = pick(buildReqWriteTools(d2), 'supplement_requirement');
  const out = await t2.handler({ reqId: 'r_v1', text: 'x' }, { colleagueId: 'cl_1' });
  assert.equal(out.ok, true, '记录成功但注明了暂不生成');
  assert.match(out.reply, /配置齐全后/);
  assert.equal(queued, 0);
});

// ── P4：upload_design_ref（设计稿挂到地图页）

const MAP2 = {
  pages: [
    { id: 'p1', name: '首页', figmas: [] },
    { id: 'p2', name: '详情页', figmas: [] },
  ],
};

test('upload_design_ref：可见性/角色（仅 design）', () => {
  const t = pick(buildReqWriteTools(deps()), 'upload_design_ref');
  assert.deepEqual(t.roles, ['design']);
});

test('upload_design_ref：多页未指定 → 返回页面清单让模型问清，不写盘', async () => {
  let wrote = false;
  const d = deps({
    readMapVersion: async () => JSON.parse(JSON.stringify(MAP2)),
    writeMapVersion: async () => (wrote = true),
  });
  const t = pick(buildReqWriteTools(d), 'upload_design_ref');
  const out = await t.handler({ reqId: 'r_a1', url: 'https://figma.com/x' }, { colleagueId: 'cl_1' });
  assert.ok(out.error);
  assert.deepEqual(out.pages, [{ id: 'p1', name: '首页' }, { id: 'p2', name: '详情页' }]);
  assert.equal(wrote, false);
});

test('upload_design_ref：指定 pageId 成功 → 合并写入 + 回执 + remove-figma 锚点', async () => {
  const map = JSON.parse(JSON.stringify(MAP2));
  let wrote = null;
  const notes = [];
  const d = deps({
    readMapVersion: async () => map,
    writeMapVersion: async (req, m) => (wrote = m),
    updateRequirement: (id, patch, event) => notes.push(event),
  });
  const t = pick(buildReqWriteTools(d), 'upload_design_ref');
  const out = await t.handler({ reqId: 'r_a1', url: 'https://figma.com/design/abc', label: '默认态', pageId: 'p2' }, { colleagueId: 'cl_1' });

  assert.equal(out.ok, true);
  assert.match(out.reply, /详情页/);
  const added = wrote.pages.find((p) => p.id === 'p2').figmas;
  assert.equal(added.length, 1);
  assert.equal(added[0].url, 'https://figma.com/design/abc');
  assert.equal(added[0].label, '默认态');
  assert.match(notes[0], /详情页/);

  const undo = t.buildUndo({ reqId: 'r_a1' }, out, {});
  assert.deepEqual(undo, { kind: 'remove-figma', reqId: 'r_a1', pageId: 'p2', figmaId: out.__private.figmaId });
  assert.ok(undo.figmaId, 'figmaId 必须带上，否则撤销删不掉');
});

test('upload_design_ref：单页地图自动选页；非 figma 链接拒绝；无地图拒绝', async () => {
  const single = { pages: [{ id: 'p1', name: '首页', figmas: [] }] };
  let wrote = null;
  const d = deps({
    readMapVersion: async () => JSON.parse(JSON.stringify(single)),
    writeMapVersion: async (req, m) => (wrote = m),
  });
  const t = pick(buildReqWriteTools(d), 'upload_design_ref');
  const ok = await t.handler({ reqId: 'r_a1', url: 'https://figma.com/x' }, { colleagueId: 'cl_1' });
  assert.equal(ok.ok, true);
  assert.equal(wrote.pages[0].figmas.length, 1);

  const bad = await t.handler({ reqId: 'r_a1', url: 'https://example.com/x' }, { colleagueId: 'cl_1' });
  assert.ok(bad.error);

  const t2 = pick(buildReqWriteTools(deps({ readMapVersion: async () => null })), 'upload_design_ref');
  const noMap = await t2.handler({ reqId: 'r_a1', url: 'https://figma.com/x' }, { colleagueId: 'cl_1' });
  assert.match(noMap.error, /地图/);
});
