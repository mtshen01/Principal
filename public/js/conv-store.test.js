/**
 * 会话存储的多窗口安全（2026-10-16 用户反馈「本项目新建的会话保存不下来，列表只剩很老的会话」）。
 *
 * 事故实况（从 WebView 的 Local Storage（LevelDB）里逐版本挖出来的）：
 *   claude_convs 是**整表**键，且被所有项目窗口共享（一窗一项目 = 一个项目一个窗口）。
 *   每个窗口各持一份内存镜像，写入时整表覆盖 → 谁落后谁就把别人的会话抹掉：
 *   17:28 的落盘里有 17:00~17:04 在本项目新建的 3 个会话；17:31 另一个窗口（镜像停在 10/15）
 *   整表覆盖后，那 3 个会话连同另一窗口 17:25 的会话一起消失，另有会话从 26 条消息回退到 22 条。
 *
 * 所以这里锁死两条不变量：
 *   ① 任何改动都必须以 localStorage 的**当前内容**为底（mutateConvs/各 convSet* 内部读改写），
 *      别的窗口在此期间新增的会话一条都不能少；
 *   ② 另一个窗口写入后（storage 事件），本窗镜像立即作废并通知视图，不能继续拿陈旧镜像覆盖别人。
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  loadConvs, reloadConvs, mutateConvs, saveConvs, flushConvs,
  convPushMessage, convSetMsgFields, convDelete, onConvsChange, bindConvsCrossWindow,
} from './conv-store.js';

const KEY = 'claude_convs';
let dom;
let realLS;

/** 直接把「磁盘上的」内容换掉，模拟别的窗口写入（本窗内存镜像不动） */
function writeStorageExternally(json) {
  realLS.setItem(KEY, json);
}
function storedIds() {
  return JSON.parse(realLS.getItem(KEY) || '[]').map((c) => c.id);
}
function conv(id, over = {}) {
  return { id, title: id, session: null, cwd: 'D:/p', messages: [], updatedAt: 1, ...over };
}

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  realLS = dom.window.localStorage;
  globalThis.localStorage = realLS;
  bindConvsCrossWindow(dom.window); // 本文件的 import 早于 window 存在，需显式挂 storage 监听
});

after(() => {
  dom?.window?.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
});

beforeEach(() => {
  globalThis.localStorage = realLS;
  realLS.clear();
  reloadConvs(); // 清空后重新解析 → 模块内镜像也归零，用例之间互不影响
});

test('回归：别的窗口刚建的会话，不会被本窗的改动整表覆盖掉', () => {
  // 本窗载入时磁盘上只有 c_old（本窗镜像就此定型）
  writeStorageExternally(JSON.stringify([conv('c_old')]));
  reloadConvs();

  // 另一个项目窗口在磁盘上写入了一条本窗还不知道的会话
  writeStorageExternally(JSON.stringify([conv('c_old'), conv('c_other')]));

  // 本窗给 c_old 加消息并落盘
  convPushMessage('c_old', 'user', '你好');
  flushConvs();

  assert.deepEqual(storedIds().sort(), ['c_old', 'c_other']);
  const cOld = JSON.parse(realLS.getItem(KEY)).find((c) => c.id === 'c_old');
  assert.equal(cOld.messages.length, 1, '本窗自己的改动当然也要落盘');
});

test('回归：本窗新建的会话，也不会被别的窗口随后丢弃（改动一律落在最新内容上）', () => {
  writeStorageExternally(JSON.stringify([conv('c_old')]));
  reloadConvs();

  // 本窗新建 c_mine（新会话开关等字段快照）
  mutateConvs((list) => {
    list.push(conv('c_mine', { messages: [{ role: 'user', text: '在' }] }));
  });
  flushConvs();
  assert.ok(storedIds().includes('c_mine'));

  // 另一个窗口拿到这份最新内容后再写自己的改动（读改写）→ c_mine 必须还在
  const other = JSON.parse(realLS.getItem(KEY));
  other.find((c) => c.id === 'c_old').title = '别人改的';
  writeStorageExternally(JSON.stringify(other));
  reloadConvs();

  assert.deepEqual(storedIds().sort(), ['c_mine', 'c_old']);
  assert.equal(loadConvs().find((c) => c.id === 'c_old').title, '别人改的', '外部更新要被采纳');
});

test('跨窗口覆盖：storage 事件作废本窗镜像，并通知订阅者重画', () => {
  writeStorageExternally(JSON.stringify([conv('c_old')]));
  reloadConvs();

  const hits = [];
  const off = onConvsChange(() => hits.push(reloadConvs().map((c) => c.id)));

  // 别的窗口写入后浏览器在本窗派发 storage（本窗自己写不触发，语义由浏览器保证）
  writeStorageExternally(JSON.stringify([conv('c_old'), conv('c_ext')]));
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: KEY, newValue: realLS.getItem(KEY) }));

  assert.deepEqual(hits, [['c_old', 'c_ext']], '订阅者应被通知，且此时读到的是外部新内容');
  assert.equal(realLS.getItem(KEY).includes('c_ext'), true);

  // 与本键无关的事件不打扰视图（别的键写得很频繁：草稿、偏好…）
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'claude_model', newValue: 'auto' }));
  assert.equal(hits.length, 1);
  off();
});

test('convSet* 系列同样读改写：外部新增会话 + 打补丁字段，两条都不丢', () => {
  writeStorageExternally(JSON.stringify([conv('c1', { messages: [{ role: 'assistant', text: '' }] })]));
  reloadConvs();
  writeStorageExternally(JSON.stringify([
    conv('c1', { messages: [{ role: 'assistant', text: '' }] }),
    conv('c2', { messages: [{ role: 'user', text: '别人发的' }] }),
  ]));

  convSetMsgFields('c1', 0, { runId: 'run_1' });
  flushConvs();

  const stored = JSON.parse(realLS.getItem(KEY));
  assert.deepEqual(stored.map((c) => c.id).sort(), ['c1', 'c2']);
  assert.equal(stored.find((c) => c.id === 'c1').messages[0].runId, 'run_1');
});

test('删除也落在最新内容上：不能把外部新增会话一起带走', () => {
  writeStorageExternally(JSON.stringify([conv('c1'), conv('c2')]));
  reloadConvs();
  writeStorageExternally(JSON.stringify([conv('c1'), conv('c2'), conv('c3')]));

  convDelete('c1');
  flushConvs();

  assert.deepEqual(storedIds().sort(), ['c2', 'c3']);
});

test('防抖窗口内（本窗有未落盘改动）别的窗口写入：两边都不丢', () => {
  writeStorageExternally(JSON.stringify([conv('c_old')]));
  reloadConvs();

  // 本窗新建会话：写入还压在 500ms 防抖里，没落盘
  mutateConvs((list) => list.push(conv('c_mine', { messages: [{ role: 'user', text: '在' }] })));

  // 另一个窗口此刻按它看到的内容写入（它不知道 c_mine）
  writeStorageExternally(JSON.stringify([conv('c_old'), conv('c_other')]));

  // 本窗继续动手：取最新这一步必须合并，而不是直接采纳外部内容（否则 c_mine 当场蒸发）
  convSetMsgFields('c_mine', 0, { runId: 'run_1' });
  flushConvs();

  assert.deepEqual(storedIds().sort(), ['c_mine', 'c_old', 'c_other']);
  assert.equal(loadConvs().find((c) => c.id === 'c_mine').messages[0].runId, 'run_1');
});

test('storage 事件落在防抖窗口内：合并落盘并通知视图，而不是作废本窗镜像', () => {
  writeStorageExternally(JSON.stringify([conv('c_old')]));
  reloadConvs();
  mutateConvs((list) => list.push(conv('c_mine')));

  const hits = [];
  const off = onConvsChange(() => hits.push(loadConvs().map((c) => c.id)));
  writeStorageExternally(JSON.stringify([conv('c_old'), conv('c_ext')]));
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: KEY, newValue: realLS.getItem(KEY) }));

  assert.deepEqual(hits, [['c_old', 'c_mine', 'c_ext']], '通知时镜像里应已经是合并结果');
  assert.deepEqual(storedIds(), ['c_old', 'c_mine', 'c_ext'], '合并结果应立刻落盘，不等防抖');
  off();
});

test('mutateConvs：fn 返回 false 表示没改动，不写也不落盘', () => {
  writeStorageExternally(JSON.stringify([conv('c1')]));
  reloadConvs();

  assert.equal(mutateConvs(() => false), null);
  flushConvs();
  assert.deepEqual(storedIds(), ['c1']);

  const list = mutateConvs((all) => { all[0].title = '改过了'; });
  assert.equal(list.length, 1);
  flushConvs();
  assert.equal(JSON.parse(realLS.getItem(KEY))[0].title, '改过了');
});

test('写入失败（配额满）不更新「已落盘」水位：内存里的新消息不会被磁盘旧快照吞掉', () => {
  writeStorageExternally(JSON.stringify([conv('c1')]));
  reloadConvs();

  const failing = {
    getItem: (k) => realLS.getItem(k),
    removeItem: (k) => realLS.removeItem(k),
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  globalThis.localStorage = failing;
  convPushMessage('c1', 'user', '配额满时发的这句');
  flushConvs();
  globalThis.localStorage = realLS;

  // 镜像没被磁盘上的旧快照覆盖（否则用户会看到「刚发的消息又没了」）
  assert.equal(loadConvs().find((c) => c.id === 'c1').messages.length, 1);
  assert.equal(reloadConvs().find((c) => c.id === 'c1').messages.length, 1);
});

test('saveConvs 仍是「整表写」的底层出口（供测试/迁移用）：以传入列表为准', () => {
  writeStorageExternally(JSON.stringify([conv('c1')]));
  reloadConvs();
  saveConvs([conv('c1'), conv('c2')]);
  flushConvs();
  assert.deepEqual(storedIds(), ['c1', 'c2']);
});
