# 同事侧对话 Agent 化 P5 · 设计（web 监管面 + 主机飞书卡片）

> 状态：**已实现（2026-10-09）** ｜ 日期：2026-10-09 ｜ 前置：`2026-09-22-colleague-agent-design.md`（2.0）；P1~P4 已完成（见 `2026-10-09-colleague-agent-p4-design.md`）
>
> 影响面：`src/store/colleague-messages.js`、`src/entrypoints/web/routes-requirements.js`（+ 新 handler）、`src/entrypoints/web/colleague-dev.js`、`src/shared/agent-undo-card.js`（新）、`src/plugins/colleague-agent/`（新 `card-action.js`）、`public/index.html` / `app.js` / `app.css` / 新 `colleague-supervisor.js`、`tests/e2e-panels-smoke.mjs`

## 一、范围与拍板记录

P5 = 2.0 第五期，也是最后一期：**按人看对话 + 工具轨迹 + 一键撤销**（web 监管面），以及 **主机飞书卡片推送**（P2 计划里明确 defer 到 P5 的部分）。

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 监管面落点 | **顶栏图标 + 独立 panel-page**（`data-view="colleagues"`，与「行为」「项目地图」同范式）。不进「行为」面板的 tab：那里是任务/日志，监管面是长期驻留的工作台，语义与布局都不同 |
| 2 | 读/写边界 | **本期为只读监管**（看对话、看轨迹、撤销 AI 写操作）。不提供从监管面主动发消息 —— 发送端点要带 reqId（按需求归属），与「按人」锚点不符，留给未来按人发送时一并设计 |
| 3 | 一键撤销数据源 | `agent-actions` 台账（P4 已在写）。面板按 colleagueId 过滤展示；撤销走 P4 已就绪的 `POST /api/req/agent-action/undo`（**UI 就是它缺的那块**） |
| 4 | 主机卡片推送时机 | `colleague-dev.js#commitAndMerge` 写完台账**之后**推（此时才有真实锚点 actionId + merge 结果）。已合并丨待合并丨合并失败三种结局都推，与「不藏事」口径一致 |
| 5 | 卡片开关 | 复用 `uiPrefs.taskNotifyFeishu`（🔔 飞书通知，默认关；与 task-notify 同一「主动打扰」语义）。**关着仍照常写台账**，只是不推送 —— 撤销能力不依赖通知 |
| 6 | 卡片回调执行位置 | 卡片事件到 feishu 进程；撤销执行在 web 进程。回调 handler 注册在 `colleague-agent/card-action.js`（feishu 侧），**跨进程 POST** `/api/req/agent-action/undo`（与 relay / create-session 同款范式）。权限闸 `canOperateRelay`（与任务卡片同口径） |
| 7 | 工具轨迹展示 | 直接展示出站消息已落盘的 `toolTrace`（P3 时刻意留的数据源）：每条工具一个 chip（短名 + input 摘要 title）。不做完整入参展开（P4 纪律：模型上下文之外的内部细节少进 UI 正文，title 悬浮足够） |

**不做**：按人主动发消息、监管面内的 session/agent 参数编辑、owner 侧改造、群聊多人视图、卡片上的「补发/重跑」。

## 二、数据接口

### 2.1 store 追加（`store/colleague-messages.js`）

```js
/** 全体会话摘要（监管面列表用）——一次读盘出全部，逐人 getColleagueThread 是 N 次读盘 */
export function listThreadSummaries() {
  // → [{ colleagueId, unread, lastAt, lastDir, lastText(≤80), messageCount, lastInboundAt }]
}
```
`unread` 口径：`dir==='in' && status==='unread'`（**不带 reqId 过滤** —— 监管面按人看；侧栏红点仍走 `getUnreadTotals` 的按需求口径，两者互不替代）。

### 2.2 路由（`routes-requirements.js`，四条）

| 路由 | 行为 |
|---|---|
| `GET /api/req/colleague-threads` | 名册 × 摘要合并：`{ threads: [{ colleagueId, name, role, roleLabel, feishuOpenId, hasThread, unread, lastAt, lastText, messageCount }] }`；排序：有对话的按 lastAt 倒序在前，无对话的按名册顺序殿后 |
| `GET /api/req/colleague-thread?colleagueId=` | `{ colleague, messages, reqTitles, lastInboundAt }`；messages = 该人**跨需求整条线**；reqTitles = 消息里出现过的 reqId → 标题（供界面显示归属） |
| `GET /api/req/agent-actions?colleagueId=&undoable=1` | `{ actions }`：台账（倒序），可选过滤。`undoable=1` 只回 `isUndoable`（有锚点且未撤过）。上限 200 条防御 |
| `POST /api/req/colleague-thread/read {colleagueId}` | 该人全部未读置已读（`markColleagueRead(colleagueId)` 无 reqId 过滤的形态） |

### 2.3 前端（`public/js/colleague-supervisor.js`，新）

- 布局：左列同事列表（`.cc-row` 复用 + 未读 `.cc-badge`），右列 = 会话流（`.cc-msg` 复用；出站消息附 toolTrace chips、入站消息附 `handledBy==='ai'` 徽标与 handledNote）+ 底部「AI 改动台账」区（工具名 / 摘要 / 时间 / 撤销按钮，仅 undoable 可点）。
- 轮询 10s（列表 + 当前会话 + 台账）；进人即调 read 路由。
- 撤销：`POST /api/req/agent-action/undo` → 成功 toast + 刷新台账（`note` 一并 toast）；失败 toast 错误（铁律不变：失败不 mark）。
- dispose：离开视图停轮询（`showView` 里与 `disposeProjectMapView` 同处理）。
- 入口：顶栏 `#colleaguesBtn`（👥 图标）→ `toggleView('colleagues')`。

## 三、主机飞书卡片

### 3.1 卡片构造/解析（新 `src/shared/agent-undo-card.js`，纯函数）

```js
export const AGENT_UNDO_CARD_KIND = 'agent-undo';
export function buildAgentUndoCard({ actionId, colleagueName, reqTitle, branch, baseBranch, outcome, at })
  // header：『同事改动已完成』（merged）/『同事改动待合并』/『同事改动合并失败』
  // 正文：谁提的、哪个需求、分支 → 基线、结局一句话
  // 按钮：[撤销这次改动]（danger，value={kind, actionId}）
export function buildAgentUndoResultCard({ ok, error, note })   // 撤销后 updateCard 用
export function parseAgentUndoCardAction(data)                   // → { actionId } | null（校验 kind）
```
放 `shared/`：推送侧在 web（`colleague-dev.js`）、解析侧在 feishu（`colleague-agent/card-action.js`），shared 是唯一共用层。按钮 value 自带 actionId，**无内存态** —— 机器人重启后旧卡片按钮仍有效（同 task-notify 的纪律）。

### 3.2 推送（`colleague-dev.js`）

`commitAndMerge` 里 `appendAction` 的返回值（P4 起返回归一化条目，含 `id`）拿到 actionId → `notifyHostUndo(...)`：fire-and-forget（同步 try/catch + Promise catch），开关/凭证/主机 open_id 任一缺失即静默跳过。**通知失败绝不影响提交与合并**。

### 3.3 回调（新 `plugins/colleague-agent/card-action.js`，feishu 侧）

`registerCardKindHandler('agent-undo', handler)`（模块加载副作用，index.js 引入）：
1. 解析 value；2. 权限闸 `canOperateRelay(operator, permOpts())`（与任务卡片同一套）；3. 跨进程 `POST http://127.0.0.1:<web.port>/api/req/agent-action/undo`，**超时 30s**（撤销可能跑 git revert，3s 不够）；4. `updateCard` 显示结果（成功附 note；失败原文如实显示）。
非授权点击 → updateCard 提示「无权操作」，不发起撤销。

## 四、失败语义

| 失败点 | 行为 |
|---|---|
| 卡片推送失败（lark 抛/返回 null） | logger.warn，不影响提交/合并/台账 |
| 卡片回调的 web 请求失败/超时 | updateCard 显示失败原因；**不重试**（用户可再点一次，撤销幂等：已撤过会回「已经撤销过了」） |
| 面板轮询失败 | 静默（下一轮自愈）；手动撤销失败的 toast 如实显示错误 |
| 撤销本身失败 | 沿用 P4 铁律：不 markUndone、错误原文回执（卡片/面板同源） |

## 五、测试

- store：`listThreadSummaries`（未读口径、last 摘要、空 store）。
- 路由：四条新端点（含 404/400 边界、undoable 过滤、read 幂等）。
- `shared/agent-undo-card`：构造（三种 outcome 文案）、解析（kind 校验/坏 value 不炸）。
- `colleague-dev`：写台账后按开关推卡片（注入 sendCard 替身断言）、开关关时不推。
- `colleague-agent/card-action`：解析→权限→POST（注入 fetch 替身）→updateCard；无权不 POST。
- e2e：`panels-smoke` 补 `#colleaguesBtn` 打开/关闭断言。
- 门禁：`npm test` 全绿 + `npm run test:e2e` 全绿。

## 六、交付边界（P5 后 2.0 全量收口）

P1~P5 完成后，2.0 设计稿 §9 分期表全部兑现；`docs/superpowers/roadmap.md` 收官标注；遗留项（`postToWeb` 抽 shared、owner 侧 agent 化、群聊多人协作）保持未立项状态。
