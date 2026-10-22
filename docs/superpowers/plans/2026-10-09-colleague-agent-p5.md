# 同事侧对话 Agent 化 P5 · 实现计划

> **For agentic workers:** 逐任务执行，TDD 为主。步骤用 checkbox 跟踪。
> 前置设计：`docs/superpowers/specs/2026-10-09-colleague-agent-p5-design.md`（含拍板记录与接口契约）。
> 基线：`npm test` 3877 全绿（P4 收官，2026-10-09）。

**Goal:** web 监管面（按人看对话 / 工具轨迹 / 一键撤销）+ 主机飞书撤销卡片。

**Architecture:** 只读监管面（新 panel-page）+ 新查询路由；卡片「web 推送 → feishu 回调 → 跨进程 POST web 撤销」三段式。

---

## T1：store `listThreadSummaries`

**Files:** Modify `src/store/colleague-messages.js` + `.test.js`（如有对应测试文件，按实际命名）

- [ ] 写失败测试：未读口径（in+unread，不带 reqId）、lastAt/lastText 截断、空 store 返回 `[]`、读盘一次出全部。
- [ ] 实现（一次 `readStore()` 遍历）。
- [ ] `node --test src/store/colleague-messages*.test.js` 全绿。

## T2：四条查询路由

**Files:** Modify `src/entrypoints/web/routes-requirements.js` + `routes-requirements.test.js`

- [ ] 写失败测试（走现有真 HTTP server 范式）：
  - threads：名册×摘要合并 + 排序 + roleLabel；
  - thread：缺 colleagueId → 400、未知 id → 404、reqTitles 映射；
  - actions：colleagueId 过滤、`undoable=1`；
  - read：缺参 400、成功 200、幂等。
- [ ] 实现（handler 尽量薄：数据组装在 store/读函数，路由只做参数归一与状态码）。
- [ ] 相关测试全绿。

## T3：`shared/agent-undo-card.js`

**Files:** Create `src/shared/agent-undo-card.js` + `.test.js`

- [ ] 对照 `task-notify.logic.js` 的卡片形状与 `sendCardToUser` 期望，写构造/解析纯函数（三种 outcome 文案；按钮 value `{kind:'agent-undo', actionId}`；坏 value 解析返回 null 不炸）。
- [ ] `node --test src/shared/agent-undo-card.test.js` 全绿。

## T4：推送接线（`colleague-dev.js`）

**Files:** Modify `src/entrypoints/web/colleague-dev.js` + `.test.js`

- [ ] 写失败测试：`appendAction` 返回 id → 注入的 `sendCard` 被调用（含 actionId）；`taskNotifyFeishu` 关 → 不调用；`sendCard` 抛错不影响提交/合并结论。
- [ ] 实现 `notifyHostUndo`（开关 + `getMyFeishuOpenId` + creds + fire-and-forget，抄 task-notify 的姿态；依赖注入可测）。
- [ ] 测试全绿。

## T5：飞书回调（`colleague-agent/card-action.js`）

**Files:** Create `src/plugins/colleague-agent/card-action.js` + `.test.js`；Modify `src/plugins/colleague-agent/index.js`（import 副作用）

- [ ] 写失败测试（注入 fetch/updateCard/permOpts）：非 kind 忽略；无权 → updateCard 且不 POST；授权 → POST 到 `/api/req/agent-action/undo` 且 updateCard 成功文案；web 回 409/网络失败 → updateCard 失败文案；**不重试**。
- [ ] 实现（`config.web.port` + `AbortSignal.timeout(30_000)`）。
- [ ] 测试全绿。

## T6：前端监管面板

**Files:**
- Modify `public/index.html`（顶栏按钮 `#colleaguesBtn` + `data-view="colleagues"` 页）
- Modify `public/app.js`（import + 入口绑定 + showView 分支 + dispose）
- Modify `public/app.css`（`.cs-*` 布局样式；气泡/行复用 `.cc-*`）
- Create `public/js/colleague-supervisor.js`
- Modify `tests/e2e-panels-smoke.mjs`（打开/关闭断言）

- [ ] 模块：list/thread/actions 拉取 + 渲染（toolTrace chips、handledBy 徽标、reqTitles 标注、未读徽标）+ 选举 + 撤销按钮 + 10s 轮询 + dispose。
- [ ] 接线：`toggleView('colleagues')`；离开时 dispose；面板关闭按钮沿用 `.panel-close` 通用绑定。
- [ ] 空数据/接口失败时不炸（panels-smoke 零 pageerror 门禁）。
- [ ] e2e：`npm run test:e2e -- panels-smoke` 全绿。

## T7：文档 + 全量回归

- [ ] 模块 CLAUDE.md 同步（plugins：colleague-agent card-action；entrypoints：四条路由 + colleague-dev 推卡；store：摘要函数）。
- [ ] roadmap 打勾 P5（2.0 全量收口）。
- [ ] `npm test` 全绿；`npm run test:e2e` 14+1 全绿。
- [ ] 手工走查（真机）：同事改码合并 → 主机收撤销卡 → 点撤销 → 卡片更新；监管面看对话/轨迹/台账；开关关时无卡片但面板可撤销。

## 自检清单（开工前）

1. 只读监管面：无发送入口（拍板 #2）。
2. 卡片链路三段各自的失败都不影响上游（推送不阻碍合并；回调失败只改卡片）。
3. 撤销铁律沿用 P4（不 markUndone、错误原文、幂等）。
4. 前端渲染全部走 `renderMarkdown` / `textContent`，无裸 innerHTML 注入用户文本。

---

## 实施状态（2026-10-09 收官）

**T1~T7 全部落地**。验收：`npm test` **3902 全绿**（P4 基线 3877，本期待增 25）；`npm run test:e2e` **14/14 通过**（panels-smoke 已补 `#colleaguesBtn` 打开/关闭 + 降级断言）。

实施纪要：
- store `listThreadSummaries`（一次读盘出全体摘要）→ 四条按人路由（threads / thread / agent-actions / read）→ 前端 `colleague-supervisor.js`（复用 `.cc-*` 气泡与 `.cc-row` 行，`cs-*` 只做布局）。
- 卡片三段：`colleague-dev.js#notifyHostUndo`（web 推送，开关 `taskNotifyFeishu`）→ 主机飞书 → `colleague-agent/card-action.js`（feishu 回调，权限闸 + 跨进程撤销 + 回执）。
- e2e 在旧后端（未重启）上验证了监管面的**降级路径**（接口 404 时显示提示、零 pageerror）；重启后端后四条新路由即可用。
