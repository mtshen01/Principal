/**
 * queue-first 排队 e2e 回归门禁（2026-10-16 对齐 OpenCode 排队语义）。
 *
 * 守的链路（真实 chat.js + 真服务端路由壳，只桩接网络）：
 *  ① 运行中发送 → /api/run/send 回 mode:'follow_up' → 消息**不进转录流**，作为排队卡片出现在输入框上方
 *     （#queueStrip，带「立即发送」/「✕」两个动作），不产生第二个 run；
 *  ② 卡片「立即发送」→ /api/run/msg/now（msgId 指向排队项）→ 卡片转「发送中…」；run 侧 consumed 事件
 *     到达 → 卡片消失、消息上屏为普通用户消息并切段（新助手占位排到其后）；
 *  ③ 卡片「✕」→ /api/run/msg/withdraw → 卡片移除，转录不变；
 *  ④ 当前 run 终结（done）→ 前端提前轮询 /api/run/pending 的 followUps（带 texts）→ 被排空的排队消息
 *     上屏 + 自动接上排空起的新 run（新 EventSource）；
 *  ⑤ 新 run 的流式输出渲染进助手气泡，不污染用户气泡。
 *
 * 自起独立 web 服务器（mkdtemp 临时 APP_DATA_DIR + 内核分配空闲端口），绝不触碰 3000 端口的真实服务。
 * 运行：node tests/e2e-follow-up-queue.mjs
 */
import { chromium } from 'playwright';
import { seedConfiguredSettings } from './helpers.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const CONV_ID = 'cFU';
const MARKER = 'FOLLOW_UP_STREAM_MARKER_7a1c';

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-first-e2e-'));
seedConfiguredSettings(dataDir);

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

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // 种子会话：cwd 必须与 localStorage 一致，否则一窗一项目过滤会把会话藏起来
  await page.addInitScript(
    ({ cwd, convId }) => {
      try {
        localStorage.clear();
      } catch {}
      localStorage.setItem('claude_cwd', cwd);
      localStorage.setItem('claude_last_conv', convId);
      localStorage.setItem(
        'claude_convs',
        JSON.stringify([
          {
            id: convId,
            title: 'queue-first 测试会话',
            session: null,
            cwd,
            model: 'auto',
            effort: 'medium',
            mode: 'default',
            provider: 'claude-agent',
            messages: [],
            updatedAt: Date.now(),
          },
        ]),
      );

      // —— Mock EventSource：按 runId 定向 emit；记录实例供断言/驱动 ——
      window.__sse = [];
      class MockES {
        constructor(url) {
          this.url = url;
          this.listeners = {};
          this.readyState = 1;
          try {
            this.runId = new URL(url, location.origin).searchParams.get('runId');
          } catch {
            this.runId = null;
          }
          window.__sse.push(this);
        }
        addEventListener(t, fn) {
          (this.listeners[t] = this.listeners[t] || []).push(fn);
        }
        removeEventListener(t, fn) {
          const a = this.listeners[t];
          if (a) {
            const i = a.indexOf(fn);
            if (i >= 0) a.splice(i, 1);
          }
        }
        close() {
          this.readyState = 2;
        }
        emit(t, data) {
          const ev = { data: JSON.stringify(data) };
          (this.listeners[t] || []).forEach((fn) => fn(ev));
        }
      }
      window.EventSource = MockES;
      window.__emitOn = (runId, t, data) => {
        const es = window.__sse.filter((e) => e.runId === runId && e.readyState === 1).at(-1);
        if (es) es.emit(t, data);
      };

      // —— 内存版排队「服务端」：/send 入队、/queue 清单、/msg/now 转 steer、/msg/withdraw 撤回 ——
      window.__queueState = {}; // convId -> [{id,text,mode}]
      window.__runInfo = { runId: 'run-1' }; // /api/run/queue 的当前运行 runId（done 后置 null）
      let fuSeq = 0;
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        const json = (o) =>
          Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const convId = localStorage.getItem('claude_last_conv');
        const body = () => {
          try {
            return JSON.parse((opts && opts.body) || '{}');
          } catch {
            return {};
          }
        };
        if (u.includes('/api/run/start')) return json({ runId: 'run-1', model: 'claude-sonnet-4', effort: 'medium' });
        if (u.includes('/api/run/send')) {
          const b = body();
          const id = 'fu_' + ++fuSeq;
          (window.__queueState[convId] = window.__queueState[convId] || []).push({ id, text: b.text, mode: 'queue' });
          return json({ ok: true, mode: 'follow_up', msgId: id });
        }
        if (u.includes('/api/run/queue')) {
          return json({ runId: window.__runInfo.runId, items: window.__queueState[convId] || [] });
        }
        if (u.includes('/api/run/msg/now')) {
          const b = body();
          const it = (window.__queueState[convId] || []).find((m) => m.id === b.msgId);
          if (!it) return json({ ok: false, code: 'gone' });
          it.mode = 'steer';
          window.__lastNow = b;
          return json({ ok: true, msgId: b.msgId, mode: 'steer' });
        }
        if (u.includes('/api/run/msg/withdraw')) {
          const b = body();
          window.__lastWithdraw = b;
          const list = (window.__queueState[convId] || []).filter((m) => m.id !== b.msgId);
          const ok = list.length !== (window.__queueState[convId] || []).length;
          window.__queueState[convId] = list;
          return json({ ok });
        }
        return realFetch(url, opts);
      };
    },
    { cwd: dataDir, convId: CONV_ID },
  );

  // /api/run/pending：初始无排空记录；切到排空阶段后回「排空已启动 run-2」（带 texts）。
  let followUpsPhase = false;
  await page.route('**/api/run/pending', async (route) => {
    const convId = await page.evaluate(() => localStorage.getItem('claude_last_conv'));
    const body = {
      pending: [],
      followUps: followUpsPhase && convId
        ? [{ convId, runId: 'run-2', ids: ['fu_3'], texts: ['DRAINED_MSG'], at: Date.now() }]
        : [],
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('#dirLabel')?.textContent?.trim(), null, {
    timeout: 15000,
  });

  const type = (text) =>
    page.evaluate((t) => {
      const el = document.querySelector('#prompt');
      el.textContent = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);

  const msgSnapshot = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#messages .msg')].map((m) => ({
        role: m.classList.contains('user') ? 'user' : 'assistant',
        text: (m.querySelector('.bubble')?.innerText || '').trim(),
      })),
    );

  // 1) 首条消息起 run-1
  await type('FIRST_TASK');
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__sse.some((e) => e.runId === 'run-1'), null, { timeout: 5000 });
  await page.evaluate(() => window.__emitOn('run-1', 'session', { session_id: 'sess-1' }));
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 2, null, { timeout: 5000 });
  step('首条消息起 run-1，助手占位气泡就位');

  // 2) 运行中发送 → queue-first：消息不进转录流，以排队卡片出现在输入框上方；不起第二个 run
  await type('QUEUED_MSG_1');
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelectorAll('#queueStrip .queue-card').length === 1, null, {
    timeout: 5000,
  });
  const cardState = await page.evaluate(() => {
    const strip = document.querySelector('#queueStrip');
    const card = strip && strip.querySelector('.queue-card');
    const conv = JSON.parse(localStorage.getItem('claude_convs')).find(
      (c) => c.id === localStorage.getItem('claude_last_conv'),
    );
    return {
      stripHidden: !strip || strip.hidden,
      text: card?.querySelector('.qc-text')?.textContent || '',
      steerLabel: card?.querySelector('.qc-steer')?.textContent || '',
      hasWithdraw: !!card?.querySelector('.qc-x'),
      msgCount: document.querySelectorAll('#messages .msg').length,
      sseCount: window.__sse.filter((e) => e.readyState === 1).length,
      transcriptHasMsg: (conv?.messages || []).some((m) => (m.text || '').includes('QUEUED_MSG_1')),
    };
  });
  if (cardState.stripHidden) fail('排队卡片条未显示');
  else step('排队卡片条就位');
  if (cardState.text !== 'QUEUED_MSG_1') fail('卡片文本不符：' + JSON.stringify(cardState));
  else step('卡片文本正确：' + cardState.text);
  if (!cardState.steerLabel.includes('立即发送') || !cardState.hasWithdraw) fail('卡片缺少「立即发送」/「✕」动作');
  else step('「立即发送 / ✕」动作在场');
  if (cardState.msgCount !== 2) fail(`排队消息不得进转录流（当前 ${cardState.msgCount} 条消息）`);
  else step('排队消息未进转录流（仍 2 条消息）');
  if (cardState.transcriptHasMsg) fail('排队消息不得写入会话存储');
  if (cardState.sseCount !== 1) fail(`排队不得起第二个 run（活 ES=${cardState.sseCount}）`);
  else step('未并发起第二个 run（仅 run-1 一条流）');

  // 3) 卡片「立即发送」→ /api/run/msg/now → 卡片转「发送中…」；consumed 到达后上屏 + 切段
  await page.click('#queueStrip .queue-card .qc-steer');
  await page.waitForFunction(
    () => document.querySelector('#queueStrip .queue-card')?.classList.contains('steering'),
    null,
    { timeout: 5000 },
  );
  const nowReq = await page.evaluate(() => window.__lastNow);
  if (!nowReq || nowReq.msgId !== 'fu_1' || nowReq.runId !== 'run-1') fail('/msg/now 未带 runId+msgId：' + JSON.stringify(nowReq));
  else step('「立即发送」已按 runId+msgId 请求 /msg/now');
  // 服务端消费（flush 进 SDK / 步边界取走）：队列清单移除该 id + 广播 consumed
  await page.evaluate(() => {
    const convId = localStorage.getItem('claude_last_conv');
    window.__queueState[convId] = (window.__queueState[convId] || []).filter((m) => m.id !== 'fu_1');
    window.__emitOn('run-1', 'consumed', { msgIds: ['fu_1'] });
  });
  await page.waitForFunction(() => document.querySelectorAll('#queueStrip .queue-card').length === 0, null, {
    timeout: 5000,
  });
  // 本段尚无文本 → 切段走「把助手占位挪到排队消息之后」：总条数不变（3 条：u1, u2, a1）
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 3, null, { timeout: 5000 });
  const afterConsume = await msgSnapshot();
  if (afterConsume[1]?.role !== 'user' || !afterConsume[1].text.includes('QUEUED_MSG_1')) {
    fail('consumed 后排队消息未上屏到用户气泡：' + JSON.stringify(afterConsume));
  } else if (afterConsume[2]?.role !== 'assistant') {
    fail('切段后助手占位未排到排队消息之后：' + JSON.stringify(afterConsume));
  } else {
    step('consumed 后消息上屏（用户气泡）+ 助手占位排到其后');
  }

  // 4) 卡片「✕」→ /api/run/msg/withdraw → 卡片移除、转录不变
  await type('QUEUED_MSG_2');
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelectorAll('#queueStrip .queue-card').length === 1, null, {
    timeout: 5000,
  });
  await page.click('#queueStrip .queue-card .qc-x');
  await page.waitForFunction(() => document.querySelectorAll('#queueStrip .queue-card').length === 0, null, {
    timeout: 5000,
  });
  const wReq = await page.evaluate(() => window.__lastWithdraw);
  if (!wReq || wReq.msgId !== 'fu_2') fail('/msg/withdraw 未带 msgId：' + JSON.stringify(wReq));
  else step('「✕」已按 msgId 请求 /msg/withdraw 并移除卡片');
  if ((await msgSnapshot()).length !== 3) fail('撤回不得改动转录流');

  // 5) run-1 终结 → 排空：卡片/本地镜像上屏 + 自动接上 run-2
  await type('QUEUED_MSG_3');
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelectorAll('#queueStrip .queue-card').length === 1, null, {
    timeout: 5000,
  });
  // 服务端排空：队列清空 + 运行中的 run 结束（follows 记录由 /api/run/pending 路由提供）
  await page.evaluate(() => {
    const convId = localStorage.getItem('claude_last_conv');
    window.__queueState[convId] = [];
    window.__runInfo.runId = null;
  });
  followUpsPhase = true;
  await page.evaluate(() =>
    window.__emitOn('run-1', 'done', { result: '第一轮完成', is_error: false, subtype: 'success' }),
  );
  await page.waitForFunction(() => window.__sse.some((e) => e.runId === 'run-2'), null, { timeout: 5000 });
  step('done 后自动发现并接上排空 run-2（新 EventSource）');
  // 排空：用户消息上屏（u3 接在 a1 之后）+ 新助手占位 a3 → 5 条
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 5, null, { timeout: 5000 });
  const afterDrain = await msgSnapshot();
  if (afterDrain[3]?.role !== 'user' || !afterDrain[3].text.includes('QUEUED_MSG_3')) {
    fail('排空消息未上屏到用户气泡（占位气泡之前）：' + JSON.stringify(afterDrain));
  } else if (afterDrain[4]?.role !== 'assistant') {
    fail('排空接流未生成助手占位：' + JSON.stringify(afterDrain));
  } else {
    step('排空消息上屏 + 新助手占位就位');
  }

  // 6) run-2 流式输出 → 渲染进助手气泡，不污染用户气泡
  await page.evaluate((m) => window.__emitOn('run-2', 'chunk', { text: m }), MARKER);
  await page.waitForTimeout(1200); // 等打字机把 marker 显示完
  const rows = await msgSnapshot();
  const inAssistant = rows.some((r) => r.role === 'assistant' && r.text.includes(MARKER));
  const inUser = rows.some((r) => r.role === 'user' && r.text.includes(MARKER));
  if (!inAssistant) fail('run-2 流式输出未渲染进助手气泡');
  else if (inUser) fail('run-2 流式输出污染了用户气泡');
  else step('run-2 流式输出只进助手气泡');

  if (pageErrors.length) fail('页面错误：\n  ' + pageErrors.join('\n  '));
  else step('零 pageerror');

  console.log(
    failures
      ? `E2E FAIL（${failures} 处）`
      : 'E2E PASS：queue-first 排队（卡片条）→ 立即发送/撤回 → 排空自动接流全链路成立',
  );
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (child) child.kill();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响测试结果 */
  }
}
