/**
 * composer 附件链路 DOM 回归（2026-10-15）：粘贴图片 → 上传副本 → chip → 发送前取 attachments。
 *
 * 为什么必须真跑 DOM：这条链跨「剪贴板事件 → 上传 → contenteditable chip → 发送时序列化」四层，
 * 中间任何一层断掉（paste 里没取 items、chip 的 dataset.path 没填上、getPromptAttachments 读错
 * 节点）服务端测试都看不见——此前 paste 一律降纯文本，截图连路径都拿不到，自定义模型的图片
 * 输入因此永远为空。这里盯死：
 *  1. 剪贴板图片真的上传并插成 chip（带服务端路径）；
 *  2. File.name 为空时给出带扩展名的上传名（无名 "file" 会让类型判定失去线索）；
 *  3. 纯文本粘贴行为不变（不带图片时仍是 execCommand 插字）；
 *  4. getPromptAttachments 只认有路径的 chip、按路径去重、clearPrompt 后为空（调用时序契约）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let dom;
let win;
let doc;
let mod;
let uploads; // 上传请求流水（url + name）
let inserted; // execCommand 插入流水

const tick = () => new Promise((r) => setTimeout(r, 0));

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="prompt" contenteditable="true"></div></body></html>', {
    url: 'http://localhost/',
  });
  win = dom.window;
  doc = win.document;
  // composer.js 顶层就查 #prompt、挂监听；模块引入前必须先把 DOM 与全局摆好
  global.window = win;
  global.document = doc;
  global.URL = win.URL;
  win.toast = { error: () => {}, info: () => {} };
  // jsdom 不实现这两个：blob 预览用 createObjectURL，粘贴纯文本用 execCommand
  win.URL.createObjectURL = () => 'blob:test';
  win.URL.revokeObjectURL = () => {};
  inserted = [];
  doc.execCommand = (cmd, _ui, text) => (inserted.push(text), true);

  uploads = [];
  global.fetch = async (url, opts = {}) => {
    const name = decodeURIComponent(String(url).replace(/^.*[?&]name=/, ''));
    uploads.push({ name, body: opts.body });
    return { json: async () => ({ path: 'C:/uploads/' + name, name }) };
  };

  mod = await import('./composer.js');
});

after(() => {
  dom.window.close();
});

function makeFile(name, type) {
  return new win.File([Uint8Array.from([1, 2, 3])], name, { type: type || 'image/png' });
}

function pasteWith(clipboardData) {
  doc.querySelector('#prompt')?.replaceChildren();
  const ev = new win.Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = clipboardData;
  doc.querySelector('#prompt').dispatchEvent(ev);
}

/** 造一个剪贴板载荷：items 与 getData 是 composer.js 用到的全部面 */
function clipboard({ files = [], text = '' } = {}) {
  return {
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    getData: () => text,
  };
}

test('粘贴图片：上传副本 → chip 带服务端路径 → getPromptAttachments 能取到', async () => {
  pasteWith(clipboard({ files: [makeFile('shot.png')] }));
  await tick();
  assert.equal(uploads.length, 1, '剪贴板图片必须真上传');
  assert.equal(uploads[0].name, 'shot.png');
  const chip = doc.querySelector('#prompt .att-chip');
  assert.ok(chip, '上传的图要插成 chip');
  assert.equal(chip.dataset.path, 'C:/uploads/shot.png');
  await tick(); // 等 uploading class 清掉（拿到路径后才可发送）
  assert.deepEqual(mod.getPromptAttachments(), [{ path: 'C:/uploads/shot.png', name: 'shot.png' }]);
});

test('粘贴图片：File.name 为空 → 生成带扩展名的上传名（不能是无名 file）', async () => {
  uploads.length = 0;
  pasteWith(clipboard({ files: [makeFile('', 'image/png')] }));
  await tick();
  assert.equal(uploads.length, 1, `本轮只应有 1 次上传，实际 ${uploads.map((u) => u.name).join(',')}`);
  assert.match(uploads[0].name, /^pasted-[a-z0-9]+\.png$/, '无名截图也要有可辨认的名字');
  assert.equal(doc.querySelector('#prompt .att-chip').dataset.path, 'C:/uploads/' + uploads[0].name);
});

test('纯文本粘贴：行为不变（execCommand 插字），不产生附件', async () => {
  inserted.length = 0;
  uploads.length = 0;
  pasteWith(clipboard({ text: '普通文字' }));
  await tick();
  assert.deepEqual(inserted, ['普通文字']);
  assert.equal(uploads.length, 0);
  assert.equal(doc.querySelectorAll('#prompt .att-chip').length, 0);
  assert.deepEqual(mod.getPromptAttachments(), []);
});

test('非图片文件（复制文件）不进附件链路；getPromptAttachments 去重且 clearPrompt 后为空', async () => {
  pasteWith(clipboard({ files: [makeFile('a.zip', 'application/zip')] }));
  await tick();
  assert.equal(uploads.length, 0, '只接管剪贴板里的图片，普通文件维持原有行为');

  // Tauri 路径 chip：直接插入（不走上传），同路径插两次只算一份
  mod.insertPathChip('C:/tmp/a.png');
  mod.insertPathChip('C:/tmp/a.png');
  assert.deepEqual(mod.getPromptAttachments(), [{ path: 'C:/tmp/a.png', name: 'a.png' }]);

  // uploading 中（无路径）的 chip 不入列——发送时拿到空路径会变成幽灵附件
  const pending = doc.createElement('span');
  pending.className = 'att-chip uploading';
  doc.querySelector('#prompt').appendChild(pending);
  assert.deepEqual(mod.getPromptAttachments(), [{ path: 'C:/tmp/a.png', name: 'a.png' }]);

  mod.clearPrompt();
  assert.deepEqual(mod.getPromptAttachments(), [], 'clearPrompt 之后取不到（所以必须先取后清）');
});
