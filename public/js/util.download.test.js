/**
 * 附件下载（util.js#downloadFile）的回归测试 —— 2026-10-15 由「`<a href>` 导航」改为「fetch + Blob」。
 *
 * 为什么必须测：桌面版（Tauri release，webview 源 tauri.localhost）下，`<a href="/api/fs/download?…">`
 * 是**导航**，绕过 bootstrap.js 的 fetch 包装，打到内置资源协议上；`/api/fs/download` 末段没有扩展名，
 * 正好命中资源协议的「找不到回落 index.html」——用户下载 `02_meal_reminder_…_api.md` 拿到的是一整个应用页面。
 * 这类 bug 服务端全绿、单测不驱动 DOM 也看不见，只能靠真跑一遍断言「下下来的是响应体字节」。
 *
 * 盯死的四件事：
 * 1. 请求走**相对路径** `/api/fs/download`（绝对基址的改写归 bootstrap 管，不能再拼一份）；
 * 2. 存盘名取服务端 Content-Disposition（中文名走 RFC 5987 的 filename*）；
 * 3. 交给下载的是响应体字节（而不是被回落到的 HTML）；
 * 4. 成功/失败都有提示 —— 「点了下载没有任何反馈」是本次一并要修的用户诉求。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let dom;
let downloadFile;
let fsDownloadUrl;
let filenameFromDisposition;
let toast;
let fetched; // fetch 调用流水：{ url }
let clicked; // 被点掉的临时 <a>：{ href, download }
let revoked; // URL.revokeObjectURL 的调用参数
let pendingTimers; // 被拦下的 setTimeout（回收 objectURL 用）

/** 造一个 fetch 响应替身；headers 只实现 get() */
function respOf({ ok = true, status = 200, disposition = '', body = 'hello', json = null } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-disposition' ? disposition : null) },
    blob: async () => new dom.window.Blob([body], { type: 'application/octet-stream' }),
    json: async () => {
      if (json === null) throw new Error('not json');
      return json;
    },
  };
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://tauri.localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  toast = { success: [], error: [] };
  dom.window.toast = {
    success: (m) => toast.success.push(m),
    error: (m) => toast.error.push(m),
    info: () => {},
  };

  // 点 <a> 由 jsdom 接管会走「navigation not implemented」并留下噪音；在这里只记录、不导航
  clicked = [];
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    clicked.push({ href: this.getAttribute('href'), download: this.getAttribute('download') });
  };

  revoked = [];
  globalThis.URL = {
    createObjectURL: () => 'blob:mock-url',
    revokeObjectURL: (u) => revoked.push(u),
  };

  fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push({ url: String(url) });
    return respOf({ disposition: "attachment; filename=\"m4xk-02_api.md\"; filename*=UTF-8''02_%E7%94%A8%E9%A4%90%E6%8F%90%E9%86%92_api.md" });
  };

  ({ downloadFile, fsDownloadUrl, filenameFromDisposition } = await import('./util.js'));
});

after(() => {
  dom?.window?.close();
});

beforeEach(() => {
  fetched.length = 0;
  clicked.length = 0;
  revoked.length = 0;
  toast.success.length = 0;
  toast.error.length = 0;
  pendingTimers = [];
});

/** 拦住 setTimeout，免得 10s 的 objectURL 回收把测试进程一直挂住 */
async function withoutRealTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms) => {
    pendingTimers.push({ cb, ms });
    return 0;
  };
  try {
    await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

// ── 纯函数：URL 拼装 ────────────────────────────────────────────

test('fsDownloadUrl：相对路径 + 两个参数都转义；name 缺省时不带该参数', () => {
  const url = fsDownloadUrl('C:\\a b\\附件.md', '附件 名.md');
  assert.ok(url.startsWith('/api/fs/download?'), `必须是相对路径（打包态改写交给 bootstrap）：${url}`);
  assert.ok(url.includes('path=C%3A%5Ca%20b%5C'), `path 应转义：${url}`);
  assert.ok(url.includes('name=%E9%99%84%E4%BB%B6%20%E5%90%8D.md'), `name 应转义：${url}`);
  assert.ok(!fsDownloadUrl('C:\\a.md').includes('&name='), '无登记名时不该带空 name');
});

// ── 纯函数：文件名解析 ──────────────────────────────────────────

test('filenameFromDisposition：优先 filename* 的 UTF-8 名（中文名只有它能保住）', () => {
  const cd = "attachment; filename=\"m4xk-api.md\"; filename*=UTF-8''02_%E7%94%A8%E9%A4%90%E6%8F%90%E9%86%92_api.md";
  assert.equal(filenameFromDisposition(cd, 'fallback.md'), '02_用餐提醒_api.md');
});

test('filenameFromDisposition：只有 ASCII 名 / 空头 / 畸形编码都回落到兜底名，不抛', () => {
  assert.equal(filenameFromDisposition('attachment; filename="api.md"', 'x.md'), 'api.md');
  assert.equal(filenameFromDisposition('', 'x.md'), 'x.md');
  assert.equal(filenameFromDisposition(null, 'x.md'), 'x.md');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E4%B8%8D", 'x.md'), '不');
  assert.doesNotThrow(() => filenameFromDisposition("attachment; filename*=UTF-8''%ZZ", 'x.md'));
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%ZZ", 'x.md'), 'x.md');
});

// ── downloadFile：成功路径 ──────────────────────────────────────

test('下载成功：打到相对路径的下载端点，存盘名用服务端定名，内容取响应体字节，且弹「已下载」', async () => {
  globalThis.fetch = async (url) => {
    fetched.push({ url: String(url) });
    return respOf({ body: '# 真的文档', disposition: "attachment; filename=\"m4xk-api.md\"; filename*=UTF-8''%E7%9C%9F%E7%9A%84%E6%96%87%E6%A1%A3.md" });
  };

  let capturedBlob = null;
  const realCreate = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = (blob) => {
    capturedBlob = blob;
    return realCreate(blob);
  };

  await withoutRealTimers(() => downloadFile('C:\\up\\m4xk-api.md', 'api.md'));

  assert.equal(fetched.length, 1, '应恰好发一次请求');
  assert.ok(fetched[0].url.startsWith('/api/fs/download?'), `必须是相对路径：${fetched[0].url}`);
  assert.ok(fetched[0].url.includes('path=C%3A%5Cup%5Cm4xk-api.md'), fetched[0].url);

  assert.equal(clicked.length, 1, '应点掉一个临时 <a>');
  assert.equal(clicked[0].href, 'blob:mock-url');
  assert.equal(clicked[0].download, '真的文档.md', '存盘名该用服务端的 filename*（中文名不得丢）');
  assert.ok(capturedBlob, '必须把响应体包成 Blob 交给下载');
  assert.equal(await capturedBlob.text(), '# 真的文档', '交给下载的必须是响应体字节');
  assert.equal(dom.window.document.querySelector('a'), null, '触发后临时 <a> 必须移除');
  assert.deepEqual(toast.success, ['已下载：真的文档.md']);
  assert.deepEqual(toast.error, []);

  // 立刻 revoke 会让部分 webview 当成本次下载被取消：必须是延后回收
  assert.deepEqual(revoked, [], '不该同步回收 objectURL');
  assert.equal(pendingTimers.length, 1);
  assert.equal(pendingTimers[0].ms, 10000);
  pendingTimers[0].cb();
  assert.deepEqual(revoked, ['blob:mock-url']);
});

test('下载成功但服务端没给 Content-Disposition：回落到调用方传的登记名', async () => {
  globalThis.fetch = async (url) => {
    fetched.push({ url: String(url) });
    return respOf({ disposition: '' });
  };
  await withoutRealTimers(() => downloadFile('C:\\up\\m4xk-api.md', 'api.md'));
  assert.equal(clicked[0].download, 'api.md');
});

// ── downloadFile：失败路径 ──────────────────────────────────────

test('端点报错（400 缺参 / 404 文件不存在）：提示服务端文案，且不产生任何下载', async () => {
  globalThis.fetch = async (url) => {
    fetched.push({ url: String(url) });
    return respOf({ ok: false, status: 404, json: { error: '文件不存在：C:\\up\\gone.md' } });
  };
  await withoutRealTimers(() => downloadFile('C:\\up\\gone.md', 'gone.md'));
  assert.deepEqual(toast.error, ['文件不存在：C:\\up\\gone.md']);
  assert.deepEqual(toast.success, []);
  assert.equal(clicked.length, 0, '失败时不该点出下载');
});

test('端点报错但响应体不是 JSON：退回状态码提示，不抛给调用方', async () => {
  globalThis.fetch = async (url) => {
    fetched.push({ url: String(url) });
    return respOf({ ok: false, status: 500, json: null });
  };
  await assert.doesNotReject(() => withoutRealTimers(() => downloadFile('C:\\up\\x.md', 'x.md')));
  assert.deepEqual(toast.error, ['下载失败（HTTP 500）']);
});

test('网络层失败（后端没起来）：提示失败原因，不抛给调用方', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.doesNotReject(() => withoutRealTimers(() => downloadFile('C:\\up\\x.md', 'x.md')));
  assert.equal(toast.error.length, 1);
  assert.match(toast.error[0], /下载失败/);
  assert.equal(clicked.length, 0);
});
