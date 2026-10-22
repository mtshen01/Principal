/**
 * 任务清单面板（TodoWrite）作用域 e2e：面板只属于它自己的那条会话。
 *
 * 守的不变量 ——
 * ① 面板画在「当前会话自己的 job.todos」上：会话说 A 有清单、B 没有 → B 的 DOM 里不得出现面板；
 * ② 别的会话的活流推 `todos` 不得污染当前会话（paintJob 的 convId 硬闸）；
 * ③ 会话来回切换不得把 A 的面板带到 B（openConv 整体重建 + 各会话自己的快照）；
 * ④ 清单被清空（TodoWrite 传空数组）时面板必须**立刻**撤下，不留过期清单。
 *
 * 回归背景：2026-10-16 用户报告「第一个对话有这个内容，后面每个对话都带着它」。
 * 排查结论是「同一会话每轮续挂旧清单」（已由后端改为只在续跑时续挂，见 run-claude.logic#isContinuationRun
 * 与 run-openai.snapshot.test 的 s4），但**跨会话串台**这一层必须锁住——本用例就是那道门禁。
 *
 * 自起独立 web 服务器（mkdtemp 临时 APP_DATA_DIR + 内核分配空闲端口），只桩网络（EventSource +
 * /api/run/*），零真实模型调用；真 chat.js、真 conv-store。
 * 运行：node tests/e2e-todo-panel-scope.mjs
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

/** 会话 A 的落盘计划（服务端 run 起跑时续挂 → replay.todos 带下来） */
const PLAN_A = [
  { content: '审查 02 文档合理性', status: 'completed' },
  { content: '新增 api/meal-reminder：8 条接口', status: 'completed' },
  { content: '阻塞：回退 ?target= 通道 + 接线', status: 'pending' },
];

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

/** 桩：Mock EventSource（按 runId 定向 emit）+ /api/run/start 发号 + pending 轮询空表 */
const initScript = () => {
  try {
    localStorage.clear();
  } catch {}
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
      (this.listeners[t] || []).forEach((fn) => fn({ data: JSON.stringify(data) }));
    }
  }
  window.EventSource = MockES;
  window.__emitOn = (runId, t, data) => {
    const es = window.__sse.filter((e) => e.runId === runId && e.readyState === 1).at(-1);
    if (es) es.emit(t, data);
    return !!es;
  };
  let runSeq = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    const json = (o) =>
      Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (u.includes('/api/run/start')) return json({ runId: 'run-scope-' + (++runSeq), model: 'x', effort: 'medium' });
    if (u.includes('/api/run/send')) return json({ ok: true });
    if (u.includes('/api/run/pending')) return json({ pending: [], followUps: [] });
    return realFetch(url, opts);
  };
};

const port = Number(process.env.E2E_PORT) || (await findFreePort());
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-panel-scope-e2e-'));
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
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(initScript);
  await page.goto(BASE, { waitUntil: 'load' });
  // 等启动初始化完成（cwd 异步拉取后 dirLabel 才有内容），点太早 send() 会因 cwd 未就绪早退
  await page.waitForFunction(() => !!document.querySelector('#dirLabel')?.textContent?.trim(), null, {
    timeout: 15000,
  });

  const sendOnce = async (text) => {
    await page.evaluate((t) => {
      const el = document.querySelector('#prompt');
      el.textContent = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.click('#sendBtn');
    await page.waitForFunction(() => window.__sse.some((e) => e.readyState === 1), null, { timeout: 5000 });
    await page.waitForTimeout(300);
  };
  const convIds = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#convList .conv-item')].map((r) => r.dataset.convId).filter(Boolean),
    );
  const openConvRow = async (convId) => {
    await page.click(`#convList .conv-item[data-conv-id="${convId}"]`);
    await page.waitForTimeout(300);
  };
  const panelInfo = () =>
    page.evaluate(() => ({
      count: document.querySelectorAll('#messages .todo-panel').length,
      head: document.querySelector('#messages .todo-panel .todo-head')?.textContent || '',
      first: document.querySelector('#messages .todo-panel .todo-item .tx')?.textContent || '',
    }));
  const lastRunId = () => page.evaluate(() => window.__sse.filter((e) => e.readyState === 1).at(-1)?.runId);

  // ① 会话 A：模型侧已有清单（replay 带 todos）→ 面板就位
  await sendOnce('TASK_A');
  const convA = (await convIds())[0];
  if (!convA) throw new Error('没能建出会话 A');
  const runA = await lastRunId();
  await page.evaluate(({ runId, todos }) => window.__emitOn(runId, 'replay', { text: '', todos, status: 'running' }), {
    runId: runA,
    todos: PLAN_A,
  });
  await page.waitForTimeout(400);
  const inA = await panelInfo();
  if (inA.count !== 1 || !inA.head.includes('2/3')) fail('会话 A 未画出自己的清单面板：' + JSON.stringify(inA));
  else step(`会话 A 面板就位（${inA.head}）：${inA.first}`);

  // ② 新建会话 B：它自己没有清单 → 不得出现面板
  await page.click('#sidebarCreateBtn');
  await page.waitForTimeout(300);
  await sendOnce('TASK_B');
  const both = await convIds();
  const convB = both.find((id) => id !== convA);
  if (!convB) throw new Error('没能建出会话 B');
  const runB = await lastRunId();
  await page.evaluate(({ runId }) => window.__emitOn(runId, 'replay', { text: '', todos: [], status: 'running' }), {
    runId: runB,
  });
  await page.waitForTimeout(400);
  const inB = await panelInfo();
  if (inB.count !== 0) fail('会话 B 出现了不属于它的面板：' + JSON.stringify(inB));
  else step('会话 B（无清单）DOM 里没有面板');

  // ③ A 的流仍活着：往它推 todos，不得污染 B
  await page.evaluate(({ runId, todos }) => window.__emitOn(runId, 'todos', { todos }), { runId: runA, todos: PLAN_A });
  await page.waitForTimeout(400);
  const inB2 = await panelInfo();
  if (inB2.count !== 0) fail('A 的活流把面板画进了 B：' + JSON.stringify(inB2));
  else step('A 的活流推送 todos 不污染 B');

  // ④ 来回切会话：A 的面板不得跟到 B
  await openConvRow(convA);
  const backA = await panelInfo();
  if (backA.count !== 1 || !backA.head.includes('2/3')) fail('切回 A 后面板丢失：' + JSON.stringify(backA));
  else step('切回 A 面板仍在（A 自己的快照）');
  await openConvRow(convB);
  const backB = await panelInfo();
  if (backB.count !== 0) fail('切到 B 带上了 A 的面板：' + JSON.stringify(backB));
  else step('切到 B 不带 A 的面板');

  // ⑤ 清单被清空 → 面板立刻撤下（而不是等到本轮结束整体重绘）
  await openConvRow(convA);
  await page.evaluate(({ runId }) => window.__emitOn(runId, 'todos', { todos: [] }), { runId: runA });
  await page.waitForTimeout(400);
  const cleared = await panelInfo();
  if (cleared.count !== 0) fail('清单清空后面板未撤下：' + JSON.stringify(cleared));
  else step('清单清空 → 面板立刻撤下');

  if (pageErrors.length) fail('页面错误：\n  ' + pageErrors.join('\n  '));
  else step('零 pageerror');

  console.log(
    failures
      ? `E2E FAIL（${failures} 处）`
      : 'E2E PASS：任务清单面板严格按会话隔离，清空即撤下（无跨会话串台、无残留面板）',
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
