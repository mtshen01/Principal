/**
 * 自定义模型「上下文使用率」e2e：真 web 进程 + 本地假 OpenAI 兼容端点。
 *
 * 守的不变量 ——
 * ① 每个模型步的 usage 会经 SSE `usage` 推到前端，顶栏（.context-progress）出现「上下文 50%」
 *    （分子 = 本步 prompt_tokens，分母 = 该模型 /models 元数据里的 context_window）；
 * ② 窗口**未知**时只报 tokens、不算百分比（分母绝不猜——猜错会让用户误判要不要新开会话）；
 * ③ 用量落进会话记录（contextUsage），刷新页面后仍显示；
 * ④ 全程无 pageerror。
 *
 * 自起独立 web 服务器（mkdtemp 临时 APP_DATA_DIR + 内核分配的空闲端口），**绝不触碰 pm2 的
 * 3000 端口与仓库根数据目录**（同 e2e-openai-resume.mjs 范式）。
 * 运行：node tests/e2e-context-usage.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};
const step = (msg) => console.log('  ✔ ' + msg);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForReady(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(baseUrl + '/api/ping');
      if (r.ok) return true;
    } catch {
      /* 还没监听上，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const port = Number(process.env.E2E_PORT) || (await findFreePort());
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-usage-e2e-'));

// ---- 假 OpenAI 兼容端点：一次文本回复 + 末帧 usage（prompt_tokens = 上下文大小）----
const PROMPT_TOKENS = 64000; // 窗口 128000 → 50%
const fakeModel = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: '收到' }, finish_reason: null }],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: 12, total_tokens: PROMPT_TOKENS + 12 },
          }) +
          '\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => fakeModel.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${fakeModel.address().port}/v1`;

// ---- 播种（必须在 server 启动前）：两条凭证 —— 一条带窗口元数据，一条不带 ----
const CRED_ID = 'tk_ctx';
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify(
    {
      tokens: [
        {
          id: CRED_ID,
          providerId: 'openai-compat',
          label: 'e2e 假模型',
          token: 'sk-e2e-not-real',
          baseURL,
          models: [
            { id: 'with-window', name: 'With Window', contextWindow: 128000 },
            { id: 'no-window', name: 'No Window' },
          ],
          modelsUpdatedAt: new Date().toISOString(),
          status: 'healthy',
        },
      ],
      builtinMcp: { context7: { enabled: false } }, // 不拉 npx 子进程
      repoMap: { enabled: false }, // 不扫仓库
    },
    null,
    2,
  ),
);

let child = null;
let browser = null;
try {
  child = spawn(process.execPath, ['src/entrypoints/web/server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), APP_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', (d) => (serverOutput += d));
  child.stderr.on('data', (d) => (serverOutput += d));

  if (!(await waitForReady(BASE))) throw new Error('自起的 web 服务器未在 20s 内就绪，输出：\n' + serverOutput);
  step('web 已就绪');

  browser = await chromium.launch();

  /** 打开一个「已选中某自定义模型」的新页面（独立 context = 干净 localStorage） */
  async function openPage(model) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('[console] ' + m.text());
    });
    await page.addInitScript(
      ({ model, credId }) => {
        localStorage.setItem('claude_provider', 'openai-compat');
        localStorage.setItem('claude_custom_model', model);
        localStorage.setItem('claude_custom_label', model);
        localStorage.setItem('claude_custom_cred_id', credId);
      },
      { model, credId: CRED_ID },
    );
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.getElementById('bootOverlay')?.remove());
    await page.waitForSelector('#prompt', { timeout: 10000 });
    return { ctx, page, pageErrors };
  }

  const ctxState = (page) =>
    page.evaluate(() => {
      const box = document.getElementById('contextProgress');
      const chip = box?.querySelector('.cp-ctx');
      const tip = box?.querySelector('.cp-tooltip');
      return {
        hidden: !!box?.hidden,
        chipHidden: !!chip?.hidden,
        chip: chip?.textContent || '',
        level: chip?.dataset.level || '',
        dotHidden: !!box?.querySelector('.cp-dot')?.hidden,
        tooltip: (tip?.textContent || '').trim(),
      };
    });

  async function sendOnce(page, text) {
    await page.evaluate((t) => {
      const el = document.querySelector('#prompt');
      el.textContent = t;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, text);
    await page.click('#sendBtn');
  }

  async function waitChip(page, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await ctxState(page);
      if (!last.hidden && !last.chipHidden && last.chip) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    return last;
  }

  // ==================== ① 有窗口元数据：百分比 + tooltip ====================
  {
    const { ctx, page, pageErrors } = await openPage('with-window');
    await sendOnce(page, '你好');
    const st = await waitChip(page);
    if (st.chip !== '上下文 50%') fail('顶栏 chip 期望「上下文 50%」，实际=' + JSON.stringify(st));
    else step('顶栏出现「上下文 50%」（64k / 128k）');
    if (st.dotHidden !== true) fail('自定义模型没有额度事件，圆点不该显示：' + JSON.stringify(st));
    else step('额度圆点保持隐藏（该路径没有额度数据）');
    if (!/64k \/ 128k/.test(st.tooltip)) fail('tooltip 未显示已用/窗口：' + JSON.stringify(st.tooltip));
    else step('tooltip 显示「已用 64k / 128k tokens」');
    if (pageErrors.length) fail('① 阶段页面报错：' + pageErrors.join(' | '));

    // ③ 落进会话记录 + 刷新后仍在。
    // 等 600ms：convs 落 localStorage 是 500ms 防抖（内存缓存立即更新，盘上要等一拍）。
    await page.waitForTimeout(600);
    const rec = await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('claude_convs') || '[]');
      return list.map((c) => c.contextUsage || null).filter(Boolean);
    });
    if (!rec.length || rec[0].inputTokens !== PROMPT_TOKENS) fail('会话记录里没有 contextUsage：' + JSON.stringify(rec));
    else step('用量已落进会话记录 contextUsage');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.getElementById('bootOverlay')?.remove());
    const after = await waitChip(page, 10000);
    if (after.chip !== '上下文 50%') fail('刷新后顶栏未恢复：' + JSON.stringify(after));
    else step('刷新页面后仍显示「上下文 50%」');
    // 刷新后的 pageerror 不参与判定：reload 时旧页的 run SSE 还在，浏览器同源连接数（6）
    // 被 SSE + 轮询占满，history 这条普通请求会被挤掉 —— 与本用例无关的既定噪声。
    await ctx.close();
  }

  // ==================== ② 无窗口元数据：只报 tokens ====================
  {
    const { ctx, page, pageErrors } = await openPage('no-window');
    await sendOnce(page, '你好');
    const st = await waitChip(page);
    if (st.chip !== '上下文 64k') fail('窗口未知时期望「上下文 64k」，实际=' + JSON.stringify(st));
    else step('窗口未知 → 只报「上下文 64k」，不编百分比');
    if (/%/.test(st.chip)) fail('窗口未知却出现了百分比：' + st.chip);
    if (!/未提供上下文窗口/.test(st.tooltip)) fail('tooltip 未说明窗口未知：' + JSON.stringify(st.tooltip));
    else step('tooltip 明确说明「该模型未提供上下文窗口」');
    if (pageErrors.length) fail('② 阶段页面报错：' + pageErrors.join(' | '));
    await ctx.close();
  }

  console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`);
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('测试异常:', e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child) child.kill();
  fakeModel.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
}
