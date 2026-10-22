// 端到端：自定义模型（openai-compat）的 Ultracode 档必须真的可用，并且真的把授权位发到服务端。
//
// 背景：Ultracode 此前对自定义模型整档不可达（`effortOptions` 不返回它、`syncEffortUI` 里 `!isCustom`
// 强制熄灭），因为 openai 路径没有 CLI 那个 Workflow 工具。现在服务端自研了等价编排
// （capabilities/workflow.logic.js），前端这一档必须解禁——并且**发送体里带上 ultracode 位**，
// 否则界面上亮着、服务端却没授权，模型永远拿不到工作流（静默失效，最难查的那种）。
//
// 加载真实前端（服务端须在 localhost:3000 运行），仅 stub 网络（EventSource + fetch），不需要真实模型。
// 运行：node tests/e2e-ultracode-custom.mjs
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000/';
const CRED_ID = 'cred_e2e_ultra';
const MODEL = 'deepseek-flash';

const initScript = ({ credId, model }) => {
  try {
    if (!localStorage.getItem('__e2e_ultra_inited')) {
      localStorage.clear();
      localStorage.setItem('__e2e_ultra_inited', '1');
    }
    localStorage.setItem('claude_provider', 'openai-compat');
    localStorage.setItem('claude_custom_model', model);
    localStorage.setItem('claude_custom_label', model);
    localStorage.setItem('claude_custom_cred_id', credId);
  } catch {}
  window.__startBodies = [];
  window.__sse = [];
  class MockES {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 1;
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
  window.__emit = (t, data) => {
    const es = window.__sse[window.__sse.length - 1];
    if (es) es.emit(t, data);
  };
  const realFetch = window.fetch.bind(window);
  let runSeq = 0;
  window.fetch = (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    const json = (o) =>
      Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    // 凭证元数据：档位 + 上下文窗口都由它来（真实链路上来自 /api/credentials）
    if (u.includes('/api/credentials')) {
      return json({
        credentials: [
          {
            id: credId,
            providerId: 'openai-compat',
            label: 'e2e 假模型',
            baseURL: 'http://127.0.0.1:9/v1',
            models: [{ id: model, name: 'DeepSeek Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 128000 }],
            modelsUpdatedAt: '2026-10-09T00:00:00.000Z',
          },
        ],
      });
    }
    if (u.includes('/api/run/start')) {
      try {
        window.__startBodies.push(JSON.parse((opts && opts.body) || '{}'));
      } catch {}
      return json({ runId: 'ultra-run-' + (++runSeq), model });
    }
    if (u.includes('/api/run/send')) return json({ ok: true });
    return realFetch(url, opts);
  };
};

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  await page.addInitScript(initScript, { credId: CRED_ID, model: MODEL });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  // 等启动初始化完成（cwd 异步拉取）：点太早 send() 会因 cwd 未就绪提前返回
  await page.waitForFunction(() => !!document.querySelector('#dirLabel')?.textContent?.trim(), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#effortBarLabel')?.textContent?.includes('中'), null, {
    timeout: 10000,
  });

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // ── 用例 1：强度档位里有 Ultracode，且厂商档位照旧 ──
  await page.click('#effortBarBtn');
  await page.waitForTimeout(200);
  const ticks = await page.evaluate(() =>
    [...document.querySelectorAll('#effortTicks .effort-tick')].map((b) => b.dataset.effort),
  );
  check('自定义模型的强度档位含 Ultracode', ticks.includes('ultracode'), ticks.join(' / '));
  check('厂商档位仍在（none + low/medium/high）', ['none', 'low', 'medium', 'high'].every((t) => ticks.includes(t)), ticks.join(' / '));
  const chipBefore = await page.textContent('#effortValue');
  check('初始落在厂商默认档（中）', /中/.test(chipBefore || ''), chipBefore);

  // ── 用例 2：点 ✨ 档 → 切到 Ultracode，容器挂上流光 class ──
  await page.click('#effortTicks .effort-tick[data-effort="ultracode"]');
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    chip: document.querySelector('#effortValue')?.textContent || '',
    barLabel: document.querySelector('#effortBarLabel')?.textContent || '',
    ultra: document.querySelector('#effortMenu')?.classList.contains('ultra'),
    popUltra: document.querySelector('#effortPop')?.classList.contains('ultra'),
  }));
  check('chip 切到 ✨ Ultracode', /Ultracode/.test(after.chip), after.chip);
  check('顶栏强度标签同步', /Ultracode/.test(after.barLabel), after.barLabel);
  check('强度面板进入流光态（.ultra）', after.ultra === true && after.popUltra === true, JSON.stringify(after));

  // 关闭强度面板：Esc（焦点还在面板内的 ✨ 刻上，菜单自己处理 Esc）。
  // 别用「点空白处」——顶栏那些标签各自会开自己的弹层（点 #dirLabel 会拉起目录选择罩，
  // 那层 mask 会拦截之后所有点击，实测踩过）。
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#effortPop')?.hidden === true, null, { timeout: 5000 });

  // ── 用例 3：工具列表里有「工作流」行（用户能像别的工具一样关掉这个烧额度的开关） ──
  await page.click('#toolsFabBtn');
  await page.waitForFunction(() => document.querySelector('#toolsPop')?.hidden === false, null, { timeout: 5000 });
  const toolsText = await page.evaluate(() => document.querySelector('#toolsPop')?.innerText || '');
  check('工具列表出现「工作流」', /工作流/.test(toolsText), toolsText.replace(/\s+/g, ' ').slice(0, 120));
  await page.click('#toolsFabBtn');
  await page.waitForFunction(() => document.querySelector('#toolsPop')?.hidden === true, null, { timeout: 5000 });

  // ── 用例 4：发送体带 ultracode:true，且 effort 仍是厂商档位（编排不擅改思考强度） ──
  await page.evaluate(() => {
    const el = document.querySelector('#prompt');
    el.textContent = '用两个子代理分别查 store 与 plugins';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#sendBtn');
  await page.waitForFunction(() => (window.__startBodies || []).length > 0, null, { timeout: 8000 });
  const body = await page.evaluate(() => window.__startBodies[0]);
  check('发送体 provider=openai-compat 且带 credId/model', body.provider === 'openai-compat' && body.credId === CRED_ID && body.model === MODEL, JSON.stringify({ p: body.provider, c: body.credId, m: body.model }));
  check('发送体带 ultracode:true', body.ultracode === true, String(body.ultracode));
  check('Ultracode 不改动 reasoning_effort', body.effort === 'medium', String(body.effort));

  check('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n❌ 失败 ${failed.length} 项` : '\n✅ 全部通过');
  await browser.close();
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
