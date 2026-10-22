// 端到端回归：queue-first 下「立即发送」消费后的流式输出必须渲染进「助手气泡」而非「用户消息气泡」。
// （原插话路径的安全网；2026-10-16 起消息先作为输入框上方的排队卡片，直到「立即发送」被消费才上屏。）
// 加载真实 public/index.html + app.js（服务端须在 localhost:3000 运行，由 npm run test:e2e 负责起），
// 仅 stub 网络（EventSource + fetch），不需要真实 Claude token。运行：node tests/e2e-steer-bubble.mjs
import { chromium } from 'playwright';

const MARKER = 'CLAUDE_STREAM_MARKER_9d2f';
const BASE = 'http://localhost:3000/';

const initScript = () => {
  try { localStorage.clear(); } catch {}
  // —— Mock EventSource：记录实例、可由测试驱动 emit ——
  window.__sse = [];
  class MockES {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 1;
      try { this.runId = new URL(url, location.origin).searchParams.get('runId'); } catch { this.runId = null; }
      window.__sse.push(this);
    }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const a = this.listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
    close() { this.readyState = 2; }
    emit(t, data) { const ev = { data: JSON.stringify(data) }; (this.listeners[t] || []).forEach((fn) => fn(ev)); }
  }
  window.EventSource = MockES;
  window.__emit = (t, data) => { const es = window.__sse[window.__sse.length - 1]; if (es) es.emit(t, data); };
  // —— Stub fetch：内存版排队服务端（/start /send /queue /msg/now） ——
  window.__queueState = {}; // convId -> [{id,text,mode}]
  let fuSeq = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const convId = localStorage.getItem('claude_last_conv');
    if (u.includes('/api/run/start')) return json({ runId: 'test-run-1', model: 'claude-sonnet-4', effort: 'medium' });
    if (u.includes('/api/run/send')) {
      const b = JSON.parse((opts && opts.body) || '{}');
      const id = 'fu_' + ++fuSeq;
      (window.__queueState[convId] = window.__queueState[convId] || []).push({ id, text: b.text, mode: 'queue' });
      return json({ ok: true, mode: 'follow_up', msgId: id });
    }
    if (u.includes('/api/run/queue')) {
      return json({ runId: 'test-run-1', items: window.__queueState[convId] || [] });
    }
    if (u.includes('/api/run/msg/now')) {
      const b = JSON.parse((opts && opts.body) || '{}');
      const it = (window.__queueState[convId] || []).find((m) => m.id === b.msgId);
      if (it) it.mode = 'steer';
      return json({ ok: true, msgId: b.msgId, mode: 'steer' });
    }
    return realFetch(url, opts);
  };
};

const type = async (page, text) => {
  await page.evaluate((t) => {
    const el = document.querySelector('#prompt');
    el.textContent = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
};

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(initScript);
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  // 等应用完成启动初始化再操作（cwd / UI 偏好是异步拉取的；过早点发送会因 cwd 未就绪提前返回）
  await page.waitForFunction(() => !!document.querySelector('#dirLabel')?.textContent?.trim(), null, {
    timeout: 15000,
  });

  // 1) 首条消息：新建 run
  await type(page, 'FIRST_TASK');
  await page.click('#sendBtn');
  await page.waitForFunction(() => window.__sse && window.__sse.length >= 1, null, { timeout: 5000 });
  await page.evaluate(() => window.__emit('session', { session_id: 'sess-1' }));
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 2, null, { timeout: 5000 });

  // 2) 运行中发送 → queue-first 排队卡片（不进转录流）
  await type(page, 'STEER_MSG');
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.querySelectorAll('#queueStrip .queue-card').length === 1, null, { timeout: 5000 });
  const queuedCount = await page.evaluate(() => document.querySelectorAll('#messages .msg').length);
  if (queuedCount !== 2) {
    console.log('❌ FAIL：排队消息不应进入消息流（当前 ' + queuedCount + ' 条）');
    await browser.close();
    process.exit(1);
  }

  // 3) 「立即发送」→ 服务端消费（广播 consumed + 清单移除）→ 消息上屏并切段
  await page.click('#queueStrip .queue-card .qc-steer');
  await page.waitForFunction(() => document.querySelector('#queueStrip .queue-card')?.classList.contains('steering'), null, { timeout: 5000 });
  await page.evaluate(() => {
    const convId = localStorage.getItem('claude_last_conv');
    window.__queueState[convId] = (window.__queueState[convId] || []).filter((m) => m.id !== 'fu_1');
    window.__emit('consumed', { msgIds: ['fu_1'] });
  });
  // 本段尚无文本 → 切段走「助手占位挪到排队消息之后」：3 条（u1, u2, a1）
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 3, null, { timeout: 5000 });

  // 4) 消费后 Claude 继续流式输出
  await page.evaluate((m) => window.__emit('chunk', { text: m }), MARKER);
  await page.waitForTimeout(1000); // 等打字机把 marker 显示完

  // 5) 断言：marker 必须出现在「助手气泡」，且不得出现在任何「用户气泡」
  const state = await page.evaluate((marker) => {
    const msgs = [...document.querySelectorAll('#messages .msg')];
    const rows = msgs.map((m) => ({
      role: m.classList.contains('user') ? 'user' : 'assistant',
      text: (m.querySelector('.bubble')?.innerText || '').trim(),
    }));
    return {
      rows,
      inAssistant: rows.some((r) => r.role === 'assistant' && r.text.includes(marker)),
      inUser: rows.some((r) => r.role === 'user' && r.text.includes(marker)),
    };
  }, MARKER);

  console.log('DOM 消息序列:');
  state.rows.forEach((r, i) => console.log(`  [${i}] ${r.role}: ${JSON.stringify(r.text.slice(0, 60))}`));

  const pass = state.inAssistant && !state.inUser;
  console.log(`\nmarker 在助手气泡: ${state.inAssistant} | marker 在用户气泡(污染): ${state.inUser}`);
  console.log(pass ? '\n✅ PASS：消费后流式输出正确渲染进助手气泡' : '\n❌ FAIL：流式输出渲染进了用户气泡（bug 复现）');

  await browser.close();
  process.exit(pass ? 0 : 1);
};

run().catch((e) => { console.error('测试异常:', e); process.exit(2); });
