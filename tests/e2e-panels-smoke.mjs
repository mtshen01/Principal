/**
 * 面板级冒烟回归：遍历全部视图/设置 tab/模型弹层/侧栏开关，全程零 pageerror。
 * 作为 app.js 拆分重构的安全网：module 化 + 严格模式的运行时破坏（隐式全局赋值等）
 * 在任何一步交互中抛错都会被捕获。须先起 localhost:3000（pm2 principal-web）。
 * 运行：node tests/e2e-panels-smoke.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3000';

/**
 * 未提交变更面板的固定数据（形状与后端 /api/workspace-changes 一致，见
 * features/workspace-changes/changes.logic.js）：一条带行号的 unified diff（含行内词级分段）
 * + 一条被删文件，树里带一层目录。用桩而不是真 git 仓库：门禁机器上的工作区状态
 * 每天都在变，拿它当断言基准等于让门禁随当天改了几个文件而飘。
 */
const CHANGES_FIXTURE = {
  ok: true,
  cwd: 'D:/e2e/stub-project',
  empty: false,
  reason: '',
  rev: 'e2efixture',
  truncated: { files: false, untracked: false },
  summary: { files: 2, added: 3, removed: 1 },
  files: [
    {
      path: 'src/e2e/a.js',
      oldPath: '',
      kind: 'modify',
      added: 2,
      removed: 1,
      deleted: false,
      binary: false,
      modeOnly: false,
      diffMode: 'unified',
      tooLarge: false,
      oldTotal: 2,
      newTotal: 3,
      truncated: false,
      hunks: [
        {
          header: '@@ -1,2 +1,3 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          rows: [
            { t: ' ', oldNo: 1, newNo: 1, text: 'const a = 1;' },
            { t: '-', oldNo: 2, newNo: null, text: 'const b = 2;' },
            {
              t: '+',
              oldNo: null,
              newNo: 2,
              text: 'const b = 3;',
              segs: [{ text: 'const b = ', em: false }, { text: '3', em: true }],
            },
            { t: '+', oldNo: null, newNo: 3, text: 'const c = 4;' },
          ],
        },
      ],
    },
    {
      path: 'README.md',
      oldPath: '',
      kind: 'delete',
      added: 0,
      removed: 1,
      deleted: true,
      binary: false,
      modeOnly: false,
      diffMode: 'unified',
      tooLarge: false,
      oldTotal: 1,
      newTotal: 0,
      truncated: false,
      hunks: [
        {
          header: '@@ -1 +0,0 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          rows: [{ t: '-', oldNo: 1, newNo: null, text: '# hello' }],
        },
      ],
    },
  ],
  tree: {
    type: 'dir',
    name: '',
    path: '',
    added: 3,
    removed: 1,
    files: 2,
    children: [
      {
        type: 'dir',
        name: 'src',
        path: 'src',
        added: 2,
        removed: 1,
        files: 1,
        children: [
          {
            type: 'dir',
            name: 'e2e',
            path: 'src/e2e',
            added: 2,
            removed: 1,
            files: 1,
            children: [
              { type: 'file', name: 'a.js', path: 'src/e2e/a.js', added: 2, removed: 1, kind: 'modify', deleted: false },
            ],
          },
        ],
      },
      { type: 'file', name: 'README.md', path: 'README.md', added: 0, removed: 1, kind: 'delete', deleted: true },
    ],
  },
};

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  // 仅收集真实运行错误；网络类 console.error（ping 探测等）不算
  if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('[console] ' + m.text());
});
const assertNoErrors = (stage) => {
  if (pageErrors.length) {
    fail(`${stage} 阶段出现页面错误：\n  ` + pageErrors.join('\n  '));
    pageErrors.length = 0;
  }
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); // 不等 CDN 资源（animejs）：module 脚本在 DCL 前已执行
  await page.waitForSelector('#messages', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600); // 等启动初始化（设置拉取/轮询首轮）
  assertNoErrors('启动');

  // 设置页全部 tab
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsTabs', { state: 'visible', timeout: 3000 });
  // tab 列表**从 DOM 动态读取**，不写死。
  // 教训（2026-08-28）：这里原先硬编码 ['basic','lark','messages','tokens',...]，
  // 而 lark / messages / tokens 三个 tab 早已在重构中消失、又新增了 claude / custom / desktop。
  // 结果本门禁长期卡在 `waiting for button[data-tab="lark"]` 超时失败，
  // 而它不在 `npm test` 里、只能手动跑，于是**没人发现安全网已经锈掉**。
  // 必须按可见性过滤：`desktop` tab 带 hidden 属性，只在 Tauri 桌面版才显出来，
  // 浏览器里点它会一直等到超时。offsetParent 判可见比查 hidden 属性可靠 ——
  // 隐藏也可能是 CSS 控制的。
  const tabs = await page.$$eval('#settingsTabs button[data-tab]', (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => e.dataset.tab),
  );
  // 下限断言不可省：选择器一旦失效会返回空数组，for 循环直接跳过 → 假绿通过。
  if (tabs.length < 3) fail(`设置 tab 只读到 ${tabs.length} 个（${tabs.join(',')}），选择器可能已失效`);
  for (const tab of tabs) {
    await page.click(`#settingsTabs button[data-tab="${tab}"]`);
    const visible = await page.isVisible(`.set-tab[data-tab="${tab}"]`);
    if (!visible) fail(`设置 tab ${tab} 未显示`);
  }
  console.log(`  设置 tab 已遍历 ${tabs.length} 个: ${tabs.join(', ')}`);
  assertNoErrors('设置页');

  // 行为面板（「需求故障」「访问日志」两个内部 tab）、JSON 工具视图。
  // 这两者原本是 tasks / logs 两个独立视图，现已合并为 behavior 一个视图 + 内部 tab 切换。
  await page.click('#behaviorBtn');
  if (!(await page.isVisible('.panel-page[data-view="behavior"]'))) fail('behavior 视图未显示');
  // tab 显隐查 hidden 属性而非 isVisible：app.js#initBehaviorTabs 正是用 .hidden 控制切换，
  // 而两个 pane 在无数据时内容为空、高度为 0，isVisible 会误判成「未显示」。
  const paneHidden = (id) => page.evaluate((i) => document.getElementById(i)?.hidden, id);
  if (await paneHidden('behaviorPane-tasks')) fail('「需求故障」tab 默认未显示');
  await page.click('#behaviorTabs [data-behavior-tab="logs"]');
  await page.waitForTimeout(300); // 切到该 tab 才懒加载日志，给拉取留时间
  if (await paneHidden('behaviorPane-logs')) fail('「访问日志」tab 未显示');
  if (!(await paneHidden('behaviorPane-tasks'))) fail('切到日志 tab 后「需求故障」应隐藏');
  assertNoErrors('面板视图');

  // 同事监管面（P5）：打开 → 面板可见 → 首轮拉取后仍零 pageerror → 关闭
  // （P4/P5 新路由需要重启后端才 200；未重启时前端应降级成提示而不是抛错——这条也在测降级路径）
  await page.click('#colleaguesBtn');
  await page.waitForSelector('.panel-page[data-view="colleagues"]', { state: 'visible', timeout: 3000 });
  await page.waitForTimeout(400); // 等列表/详情首轮拉取落定
  // 台账收成会话标题行右侧的按钮（2026-10-10），未选中同事时应禁用——不猜人开抽屉
  if (!(await page.isVisible('.cs-thread-head #csLedgerBtn'))) fail('同事页台账按钮未显示');
  if (!(await page.isDisabled('#csLedgerBtn'))) fail('未选中同事时台账按钮应禁用');
  // 发消息区（2026-10-15：需求页「开发人员」的对话能力并到这里）：没人选中时整行藏着
  if (!(await page.isHidden('#csCompose'))) fail('未选中同事时发消息区应隐藏');
  if ((await page.locator('#csReqSelect').count()) !== 1) fail('归属需求下拉缺失');
  assertNoErrors('同事监管面');
  await page.click('.panel-page[data-view="colleagues"] .panel-close');
  await page.waitForTimeout(150);

  // 未提交变更面板（取代原「项目地图」/「本次会话改动」）：点顶栏按钮 → **右侧抽屉**滑出 →
  // 主体渲染 → 两个视图切换零 pageerror → 关闭。
  // 抽屉而不是整页面板：点它不该把对话区整个换掉（那看着就像开了个新窗口）。
  await page.click('#changesBtn');
  await page.waitForSelector('.sc-drawer-host .sc-drawer', { state: 'visible', timeout: 3000 });
  if (await page.isVisible('.panel-page[data-view="changes"]')) fail('改动面板不该再有整页面板形态');
  await page.waitForTimeout(400); // 等首轮 /api/workspace-changes 往返
  if (!(await page.isVisible('#changesBody'))) fail('改动面板主体未渲染');
  const scTabs = await page.$$('#changesBody .sc-tab');
  if (scTabs.length !== 2) fail(`改动面板应有 列表/内容地图 两个视图，实为 ${scTabs.length}`);
  const scEmpty = (await page.textContent('#changesBody')).trim();
  if (!scEmpty) fail('没有可用数据时改动面板既没内容也没空态文案');
  // 版面不变量（2026-10-16 回归）：只断言「有点文字」挡不住那次事故 —— 重构 diff 视图时
  // 把「主体：左清单 / 地图 + 右 diff」整块 CSS 删掉，面板照样有文字、照样零 pageerror：
  // 左栏从定宽清单列变成通栏、内容地图的容器丢了定位祖先（画布以视口为参照铺满整页、
  // 节点被摆到视口外），用户点开看到的是一片空白，而门禁全绿。
  const scLayout = await page.evaluate(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const files = document.querySelector('#changesBody .sc-files')?.getBoundingClientRect();
    const main = cs('#changesBody .sc-main');
    const mapwrap = cs('#changesBody .sc-mapwrap');
    return {
      mainDisplay: main?.display || '',
      filesWidth: files ? Math.round(files.width) : -1,
      mapPosition: mapwrap?.position || '',
    };
  });
  if (scLayout.mainDisplay !== 'flex') fail(`改动面板主体不是左右两栏的 flex 容器（display=${scLayout.mainDisplay}）`);
  if (scLayout.filesWidth > 400) fail(`改动面板左栏没收敛成定宽清单列（width=${scLayout.filesWidth}）`);
  if (scLayout.mapPosition !== 'relative') {
    fail(`内容地图容器不是定位祖先（position=${scLayout.mapPosition}）：画布会铺到视口上，点开是空白`);
  }
  await page.click('#changesBody .sc-tab[data-sc-view="map"]'); // 切地图视图不抛错
  await page.waitForTimeout(200);
  await page.click('#changesBody .sc-tab[data-sc-view="list"]');
  await page.waitForTimeout(200);
  assertNoErrors('未提交变更面板');
  // 再点一次顶栏按钮收起（抽屉的另一种关法，且不该把对话区换掉）
  await page.click('#changesBtn');
  await page.waitForTimeout(150);
  if (await page.isVisible('.sc-drawer-host')) fail('再点顶栏按钮应收起未提交变更抽屉');

  // JSON 工具：切侧栏工具态 → 打开 → 贴 JSON → 格式化 → 出树
  await page.evaluate(() => window._setSidebarToolsMode?.(true));
  await page.click('#toolJson');
  await page.waitForSelector('.panel-page[data-view="json-tool"]', { state: 'visible', timeout: 3000 });
  await page.fill('#jsonInput', '{"a":[1,2,{"b":"中文"}],"ok":true}');
  await page.waitForTimeout(400); // input 解析有 250ms 防抖，须先等它落定
  await page.click('#jsonFormatBtn');
  await page.waitForTimeout(200);
  const treeText = await page.textContent('#jsonOutput');
  if (!treeText.includes('中文') || !treeText.includes('ok')) fail('JSON 树渲染异常: ' + treeText.slice(0, 80));
  await page.evaluate(() => window._setSidebarToolsMode?.(false));
  await page.click('.panel-page[data-view="json-tool"] .panel-close'); // 回对话，否则 fab/输入区隐藏
  await page.waitForTimeout(200);
  assertNoErrors('JSON 工具');

  // 输入框底栏：模型下拉（Claude pills 在场）+ 悬浮工具弹层
  await page.click('#modelBarBtn');
  if (!(await page.isVisible('#modelPop'))) fail('模型下拉未打开');
  const pills = await page.$$('#modelPills button');
  if (pills.length < 4) fail('模型 pills 数量异常: ' + pills.length);
  await page.click('#modelBarBtn'); // 收起
  await page.click('#toolsFabBtn');
  if (!(await page.isVisible('#toolsPop'))) fail('工具弹层未打开');
  await page.click('#toolsFabBtn'); // 收起
  assertNoErrors('模型/工具弹层');

  // 工作目录弹层：开 → 等目录列表 → 关
  await page.click('#dirBtn');
  await page.waitForSelector('#dirMask', { state: 'visible', timeout: 3000 });
  await page.waitForTimeout(400); // 目录浏览接口往返
  await page.click('#dirClose');
  await page.waitForTimeout(150);
  if (await page.isVisible('#dirMask')) fail('目录弹层未关闭');
  assertNoErrors('目录弹层');

  // 侧栏开关往返
  await page.click('#sidebarToggleBtn');
  await page.waitForTimeout(200);
  await page.click('#sidebarToggleBtn');
  assertNoErrors('侧栏开关');

  // 视图 chrome 不变量（2026-10-16）：谁的服务，就只显示谁该有的控件
  // ① 侧栏切「需求」→ 顶栏的项目控件（工作目录 / 分支）收起 —— 需求各自有工程目录，
  //    在需求 tab 下显示当前会话的项目目录是误导；切回「对话」必须恢复。
  if (await page.evaluate(() => document.getElementById('sidebar')?.classList.contains('collapsed'))) {
    await page.click('#sidebarToggleBtn'); // 侧栏收起时点不到 tab
    await page.waitForTimeout(200);
  }
  await page.click('.switch-btn[data-target="req"]');
  await page.waitForTimeout(250);
  if (await page.isVisible('#dirBtn')) fail('需求 tab 下文件夹选择器未隐藏');
  if (await page.isVisible('.git-selector-wrap .git-selector')) fail('需求 tab 下分支选择器未隐藏');
  await page.click('.switch-btn[data-target="conv"]');
  await page.waitForTimeout(250);
  if (!(await page.isVisible('#dirBtn'))) fail('切回对话后文件夹选择器未恢复');

  // ② 同事面板 → 底部输入框收起（它发的是对话消息，在本视图里发不出去、点了还会跳回聊天视图），
  //    该面板自己有唯一那个输入框；返回对话必须恢复。
  await page.click('#colleaguesBtn');
  await page.waitForSelector('.panel-page[data-view="colleagues"]', { state: 'visible', timeout: 3000 });
  await page.waitForTimeout(300);
  if (await page.isVisible('.composer')) fail('同事面板下底部输入框未隐藏');
  await page.click('.panel-page[data-view="colleagues"] .panel-close');
  await page.waitForTimeout(300);
  if (!(await page.isVisible('.composer'))) fail('返回对话后底部输入框未恢复');
  assertNoErrors('视图 chrome');

  // 输入框可交互（contenteditable 富输入；不真发送，避免烧额度）
  await page.click('#prompt');
  await page.keyboard.type('smoke 输入不发送');
  const v = await page.textContent('#prompt');
  if (!v.includes('smoke 输入不发送')) fail('输入框写入异常: ' + v);

  // 富文本粘贴降级纯文本：合成带 HTML 的粘贴事件，断言样式标签没进输入框
  const pasted = await page.evaluate(() => {
    const el = document.querySelector('#prompt');
    el.innerHTML = '';
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/html', '<b style="color:red">红字</b><h1>大标题</h1>');
    dt.setData('text/plain', '红字大标题');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { html: el.innerHTML, text: el.textContent };
  });
  if (/<(b|h1|span|style)\b/i.test(pasted.html)) fail('粘贴带入了样式标签: ' + pasted.html.slice(0, 80));
  if (!pasted.text.includes('红字大标题')) fail('纯文本粘贴内容丢失: ' + pasted.text);
  await page.evaluate(() => (document.querySelector('#prompt').innerHTML = ''));
  assertNoErrors('输入框');

  // 改动面板「有数据」这条路（上面那段只覆盖空态，而空态永远画得出东西）：
  // 给面板喂一份固定的改动数据（只桩这一个端点），然后按**几何**断言它真的画出来了 ——
  // 清单按数据出条目、两栏真的并排、内容地图的卡片真的落在面板可视区里。
  await page.route('**/api/workspace-changes*', (route) => {
    const url = new URL(route.request().url());
    const body =
      url.searchParams.get('view') === 'summary'
        ? { ok: true, cwd: CHANGES_FIXTURE.cwd, summary: CHANGES_FIXTURE.summary }
        : CHANGES_FIXTURE;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // 面板按**项目目录**取数（不再依赖会话）：把本窗 cwd 钉成一个固定值并刷新，
  // 否则这台机器上 cwd 是服务端偏好给的，取到服务所在目录时面板会走「不是 git 仓库」的空态。
  // 用 addInitScript 而不是事后赋值：cwd 在 chat.js 模块求值时就读走了，晚一步设没用。
  await page.addInitScript((dir) => { window.__PROJECT_CWD__ = dir; }, CHANGES_FIXTURE.cwd);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#messages', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(600);
  await page.click('#changesBtn');
  await page.waitForSelector('.sc-drawer-host .sc-drawer', { state: 'visible', timeout: 3000 });
  await page.waitForTimeout(800); // 等首轮 /api/workspace-changes 往返 + 地图 fitView 落定

  const scRows = await page.locator('#scFiles .sc-file').count();
  if (scRows !== CHANGES_FIXTURE.files.length) {
    fail(`改动面板清单未按数据渲染（期望 ${CHANGES_FIXTURE.files.length} 条，实为 ${scRows}）`);
  }
  const scBoxes = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return { files: box('#scFiles'), diff: box('#scDiff') };
  });
  // 两栏并排 = 右栏在左栏右边，而不是被压到左栏下面（那次 CSS 删除的直接后果）
  if (!scBoxes.files || !scBoxes.diff || scBoxes.diff.x < scBoxes.files.x + scBoxes.files.w - 1) {
    fail(`改动面板左右两栏没有并排：${JSON.stringify(scBoxes)}`);
  }

  await page.click('#changesBody .sc-tab[data-sc-view="map"]');
  await page.waitForTimeout(600);
  const scMap = await page.evaluate(() => {
    const wrap = document.querySelector('#scMapWrap');
    if (!wrap || wrap.hidden) return { ok: false, why: '内容地图容器没显示' };
    const r = wrap.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('#changesBody .rq-canvas-host .rq-nodes .rq-node')];
    const inside = nodes.filter((n) => {
      const b = n.getBoundingClientRect();
      return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
    });
    return { ok: inside.length > 0, why: `${inside.length}/${nodes.length} 个卡片落在面板可视区内` };
  });
  if (!scMap.ok) fail(`内容地图点开是空白：${scMap.why}`);
  assertNoErrors('改动面板（有数据）');

  console.log(failures ? `E2E FAIL（${failures} 处）` : 'E2E PASS：全部面板遍历零页面错误');
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
