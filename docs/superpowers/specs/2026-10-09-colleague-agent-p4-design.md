# 同事侧对话 Agent 化 P4 · 设计（其余工具 + 旧管线退役）

> 状态：**已实现（2026-10-09）** ｜ 日期：2026-10-09 ｜ 前置：`2026-09-22-colleague-agent-design.md`（2.0），P1~P3 已完成
>
> 影响面：`src/capabilities/agent-tools.js`、`src/plugins/colleague-agent/`、`src/plugins/action-runner/`、`src/plugins/tracking-stats/`、`src/plugins/team-tools/`、`src/app/intent.js`、`src/entrypoints/web/`（undo 路由 + 队列撤回 + 台账）、`src/entrypoints/feishu/`（relay 透传）、`public/js/actions-panel*.js`、`src/shared/`

## 一、范围

P4 = 2.0 的第四期：把剩余 8 个工具注册完、补齐「撤销」的兑现链条、把同事侧旧意图管线退役。

**不含**：P5 的 web 监管面（按人看对话 / 工具轨迹 UI / 主机卡片推送）、owner 侧改造、群聊多人协作。

## 二、侦察发现（现状与设计稿的差距，实现前必须知道）

1. **通用台账写入器缺失（P2 遗留）**。`buildUndo` 全仓只在测试里被调用；运行时唯一写台账的是 `colleague-dev.js#commitAndMerge`（start_dev_task 收尾）。也就是说 `register_api_doc` 的 `delete-apidoc` 锚点在运行时**从未落盘**——撤销执行器在，但没有生产者。P4 新增 5 个 reversible 工具之前必须先补上，否则「乐观执行 + 可撤销」会从地基处失效。
2. **web 进程只副作用加载 `colleague-agent`**（`server.js` listen 回调）。P4 的 `run_action`（action-runner 注册）、`tracking_report`（tracking-stats 注册）、`report_bug`（team-tools 注册）都需要显式加载对应插件模块，否则工具静默缺席（零工具 MCP server 的失败形态见 `plugins/index.js#loadPluginSideEffects` 注释）。
3. **`agentExposed` 字段不存在**（全仓仅出现在 agent-tools 测试）。需要：设置页表单、空字段省略的落盘纪律、catalog/handler 双处守闸。
4. **`undo-agent-action.js` 的两种 kind 是桩**（`revert-req-change` / `discard-task` 明确返回「需等 P4」）；P4 还要新增两种（`remove-supplement` / `remove-figma`）。
5. **同事入口当前靠 intents 白名单**（bug/feature/question/material/other），`action` 意图仍走 action-runner——P4 改为 `match` 全接（见 §五）。

## 三、拍板记录

| # | 决策点 | 结论 | 时间 |
|---|---|---|---|
| 1 | `report_bug` 语义 | **直入自动开发**：createTask + `requestAutoDevelop`；撤销走 `discard-task` | 2026-10-09 |
| 2 | 旧关键词路径退役范围 | **彻底退役**：action-runner 意图 feature 摘除；`intent.js` 的 action 分支清理；卡片按钮路径保留；对陌生人同样生效（顺带堵住非名册可触发 guest 档脚本的口径） | 2026-10-09 |
| 3 | 同事入口接管方式 | **match 全接**（发生在意图分类之前），不走 intents 扩展：省一次分类调用，且与 2.0 决策 #1「所有同事侧对话归 agent」字面一致 | 设计决定 |
| 4 | 台账写入器位置 | `capabilities/agent-tools.js#buildAgentMcpServer` 的 handler wrapper（capabilities → store 是顺向依赖） | 设计决定 |
| 5 | `run_action` 形态 | **单工具 + 动态动作清单**：schema 用稳定泛形（action + vars），按人按轮把可用动作清单注入 system prompt。不做「动态 zod schema」——注册期 schema 是静态契约，塞运行时变化会让工具描述与现场配置漂移 | 设计决定 |
| 6 | `canRunAction` 复用 | 从 `plugins/action-runner/feature/permission.js` 平移至 `shared/action-permission.js`（两插件跨用，shared 是唯一不倒挂的层） | 设计决定 |
| 7 | supplement / change 撤销语义 | **记录撤回 + 尽力撤下排队中任务**：拉掉 `req.supplements`/`req.changes` 里那一条，并从需求队列摘除/改写在排队（尚未派发）的 docgen/mapchange；下游已跑完的部分不回滚但回执**逐项说明** | 设计决定 |
| 8 | `discard-task` 状态机 | 任务未开始开发 → 置 rejected（记录撤销）；开发中 → 拒绝并如实提示；已完成 → `discardTaskById`（未合并删分支 / 已合并 revert） | 设计决定 |

## 四、通用台账写入器（基建，先行）

**位置**：`buildAgentMcpServer` 的 handler wrapper，成功路径追加：

```
handler 成功（无 throw 且 result 不是 {error}）→
  danger safe/notify        → 不写台账
  danger reversible/external → appendAction({
    colleagueId, role, msgId, reqId,       // 来自 ctx（reqId 优先 input.reqId）
    tool: d.name,
    input: mask(input),                     // store/mask.js 脱敏
    ok: true,
    resultBrief: brief(result).slice(0, 200),
    undo: external ? null : d.buildUndo(input, result, ctx),
    undone: false, undoneAt: null,
  })
```

**两条纪律**：

1. **失败不写台账**：handler 返回 `{error}`（预期内业务失败）或抛错（wrapper catch）都不写——没有发生的事没有可撤销性。
2. **reversible 的 buildUndo 运行时缺席（返回 null / 抛错）= 降级为「撤不回」**：写 `undo: null` + `logger.error` + 台账可见。设计稿 §4.2 的「视为工具执行失败并回滚」在通用层无法实现（wrapper 不知道如何回滚任意副作用），改为**不许静默**：台账如实记 `undo:null`，与 external 同一语义（已发生、撤不回），主机在台账里看得见。这是唯一不打折「不藏事」原则的降级法。

**台账写入自身失败**：fail-open，`logger.error` 后照常返回工具结果（审计失败不该打断业务，但绝不静默）。

## 五、入口退役

### 5.1 colleague-agent 改 `match` 全接

`feature.js`：

```js
match: (ctx) => isColleagueMessage(ctx?.user?.id, getColleagues())  // 名册判定，非名册不接
```

- 发生在 dispatch 第 1 步（意图分类之前），名册内同事的**文本**全部归 agent；`intents: []` 清空。
- 附件链路不变（`feishu/index.js` 早期分支 → `relay`，两条链路共用 `isColleagueMessage`，不得另写判定）。
- 非名册：match 返回假 → 走原分类 → feedback（陌生人路径不受本改动影响）。
- owner 不受影响（`claude-exec` match 对 owner 恒真且在前；colleague match 内部对 owner openId 判定为假）。

### 5.2 action-runner 摘除意图 feature

`plugins/action-runner/index.js`：

```js
features: [],               // P4：意图路径退役（恢复只需把 feature 加回）
```

- `feature/index.js`、`slot-filler.js`、`local-extract.js`、`learn-keywords.js`、`keyword-guard.js` **文件留盘不删**，文件头加退役说明（抄 `tracking-stats`「feature.js 原样留在盘上」先例）。
- `card-action.js` 保留：欢迎卡片按钮直达 `handle()` 的路径不变（显式点击，本就不经意图识别）。
- `store/learned-keywords.js`、`store/action-configs.js#appendAutoKeyword`、`var-presets.js` 等支撑件留盘。

### 5.3 intent.js 清理 action 分支

删除：L2 动作关键词单命中、L3 的 action 候选与判定、`via/actionId/actionName` 返回字段、L1 question 的「让路动作」绕行逻辑。保留 bug/feature/question/material/other 五类与 L0/L1/L4 分层。

> 影响：陌生人消息里含动作关键词的，从「触发动作」变为「按普通意图分类 → 未识别回引导文案」。这是拍板 #2 的预期结果。

### 5.4 清理台账（留档）

| 文件 | 处理 |
|---|---|
| `plugins/action-runner/feature/*`（除 card 依赖外） | 留盘 + 文件头「已退役」说明 |
| `store/learned-keywords.js` | 留盘 + 说明 |
| `app/intent.js` 的 action 相关代码 | **删除**（核心分类器不留死分支） |

## 六、新工具清单（8 个）

| 工具 | danger | roles | 能力 | 撤销 kind |
|---|---|---|---|---|
| `get_ui_spec` | safe | `*` | 读需求工程的 UI 规范文本（截断） | — |
| `submit_req_change` | reversible | product | 记 `changes[]` + 入队 mapchange（有图才跑）；回执提示「要立即改码请再走开发任务」 | `revert-req-change` |
| `supplement_requirement` | reversible | product/design | 记 `supplements[]` + 入队 docgen 修订（配置齐时）；文件按 `ctx.files` 文件名反查 | `remove-supplement` |
| `report_bug` | reversible | `*` | createTask(bug) + `requestAutoDevelop` | `discard-task` |
| `upload_design_ref` | reversible | design | 给地图页加一条 figma 引用（pageId 解析见下） | `remove-figma` |
| `run_action` | **external** | `*`（闸在 handler） | 执行动作脚本（见 §七） | `null`（撤不回） |
| `tracking_report` | safe | ops/product | 埋点/数据问答，异步 kick-off（见 §八） | — |
| `notify_host` | notify | `*` | 给主机发一条飞书私信（`getMyFeishuOpenId`） | — |

### 6.1 各工具要点

**get_ui_spec**：`readUiSpec(pickProjectDir(req.projects))`；空规范返回人话 `{error}`；截断 `UI_SPEC_MAX=8000`。与 `read_project_code` 的边界：规范是「人写的规则」，读代码是「现实长啥样」。

**submit_req_change**：
- 校验：可见 / phase∈{dev,test} / text 非空（≤`CHANGE_TEXT_MAX`，复用常量）。
- 写：`changes[]` push `{id, text, scope:'both', hits:[], at}`；`hasMap` → `enqueueSystemTask(id,'mapchange',{changeId,text})`。
- 回执：明写「已记录需求变动《title》」+「如需立刻调整代码，把要改的地方告诉我，我会安排开发任务」。**不直接起改码**——「登记」与「开发」两个工具分离，撤销粒度不同（记录 vs 分支）。

**supplement_requirement**：
- 校验：可见 / phase==='review'（与 API 一致）/ text 或 files 至少一项；files 只认 `ctx.files` 里出现过的文件名（路径不经模型）。
- 写：`supplements[]` push `{id:'s_...', text, files:[{name,path}], at}`；配置齐（cwd+reqDoc）→ `enqueueSystemTask(id,'docgen',{supplement})`；不齐 → 回执注明「已记录，配置齐全后自动纳入」。

**report_bug**：
- `createTask({type:'bug', title:text.slice(0,40), detail:text, source:{openId, via:'feishu', chatId}})` → `requestAutoDevelop(task.id, '同事对话提交')`。
- 回执：带任务标题 + 「已进入开发队列，完成后通知你」。
- undo `discard-task`：见 §九。

**upload_design_ref**：
- 校验：可见 / 有地图（`reqMap.versions` 非空）/ url 是 figma 链接（宽松判定拿不准就收）。
- pageId 解析：显式给 → 校验存在；未给且地图恰 1 页 → 用它；多页 → 返回 `{error, pages:[{id,name}]}`（页面清单对参与者本就可见）让模型问清再重试。
- 写：`mergeFigmas(page.figmas, [...(page.figmas||[]), {url,label}])` + `writeMapVersion` + `updateRequirement` 注记；回执给 `figmaId`（撤销锚点）。

**notify_host**：
- `lark.js#sendTextToUser(getActiveBot creds, getMyFeishuOpenId(), text)`。
- 无 myOpenId → `{error:'主机还没配置飞书 open_id，转达不了'}`；text ≤1000 字，服务端前置「[同事名（职位）]」署名（模型只给正文）。
- notify 档不写台账。

## 七、run_action（唯一 external 工具）

**注册**：`plugins/action-runner/agent-tools.js`（新建），随 action-runner 模块加载自注册；`roles:['*']`，注册表这层不做角色过滤，真正的裁决在 handler 内 `canRunAction(config,'guest')`（同事恒 guest，与 `colleagues.js` 的六个职位是两套角色概念，不要混用）。

**schema（稳定泛形）**：

```js
{
  action: z.string().describe('动作 id，从系统提示的「可用动作」里选'),
  vars: z.record(z.string(), z.union([z.string(), z.number()])).describe('动作要求的变量，键为变量名'),
}
```

**handler 五步**：

1. `getConfig(actionId)` 找不到 → `{error}` 人话。
2. 暴露闸：`agentExposed === false` → 拒（与清单过滤同一判据）。
3. 权限闸：`canRunAction(config, 'guest')` → 拒。
4. 变量合并与校验：
   - 合并 `user-vars` 里 `persistent` 变量的存量值（与老路径一致：不报号时复用上次；模型侧通过清单里的「上次使用：脱敏值」可见）。
   - `required` 缺失（`pickMissingVars` 同判据）→ `{error, missing:[{name,label}]}`，**不执行**。
   - enum 命中（`resolveVariable` 展开 preset 后的闭集）、pattern 校验；越界给 `{error}` 人话。
5. 执行：`runAction(config, openId, vars)` → `{ok, output: tail(800), target: describeTarget(...)}`；持久变量 `setVar(openId, name, value)`。

**确认制（软约束）**：tool description + system prompt 双处写死——「执行前先把动作、参数、目标复述给同事，得到确认才调本工具」。硬闸是 `agentExposed`（关掉即清单与执行两侧一起消失）。

**动态动作清单**：
- 新模块 `src/shared/action-catalog.js`（纯函数）：+`listAgentActions({botId, role, getConfigs, ...})`，判据与 handler 同源（enabled、botId、agentExposed、canRunAction）+ `renderActionCatalog(actions)` 渲染 prompt 块（含变量表；persistent 有值附脱敏「上次使用」；渲染长度上限 4000 字，超限截断并 warn）。
- `session.js` 每轮组装，经 `prompt.js` 注入「## 可用动作」块。

## 八、tracking_report（异步 kick-off）

**约束**：freeform 分析实测 44s~275s（预算 12min），同事 agent 单轮超时 120s——**工具必须立即返回**，结果由 tracking-stats 直发同事。

**落地**：
- `freeform.js` 抽出可复用入口 `startFreeformQuery({ text, userId, chatId, reply, ack })`（现有 handle 的限流 + 异步段复用；`ack:false` 时跳过自带的即时应答，由 agent 回复）。
- `tracking-stats/agent-tools.js` 注册 `tracking_report`（safe，roles ops/product）：
  - handler：`{question}` → `startFreeformQuery(...)`，`reply` 直发同事（`sendTextToUser(creds, openId, text)`）→ 立即返回 `{started:true, note:'...'}`；
  - 限流命中 → `{error: 限流文案}`。
- **chatId 透传链**：relay payload + `/api/req/colleague-agent/turn` + `session.js` ctx 全链加 `chatId`（feishu 入口有 `ctx.sessionKey`），供 HTML 附件 `sendFile` 使用。
- 全程复用既有四层安全（llm-sql-agent / sql-guard / sql_exec.py / sql-audit），**不新增安全判断**。

## 九、撤销执行扩展

`undo-agent-action.js` 新增四个分支（全部注入式 deps，保持可测）：

| kind | 执行 |
|---|---|
| `revert-req-change` | 摘 `req.changes` + 摘队列中同 `changeId` 的 mapchange（未派发） |
| `remove-supplement` | 摘 `req.supplements` + 从排队 docgen payload 摘掉本补充（摘空则撤任务）；已出新版则回执说明 |
| `discard-task` | 任务状态机：未开始 → 置 rejected；开发中 → 拒绝并如实提示；已完成 → `discardTaskById` |
| `remove-figma` | 地图页 `figmas` 过滤该条后覆盖写版本 |

- `store/agent-actions.js#UNDO_KINDS` 扩容至 8（+`remove-supplement`、`remove-figma`），测试同步。
- **队列撤回接口**：`requirement-ops.js` 新增导出「撤离/改写尚未出队的系统任务」的纯逻辑 + 薄壳（队列是模块内存，undo 路由同在 web 进程，进程内直接生效；**已派发的一律不动**）。判断抽纯函数单测。
- **HTTP 路由**：`POST /api/req/agent-action/undo {id}` → `undoAgentAction(id)`；UI 归 P5（P4 先给路由与测试，人工验收用 curl）。
- `markUndone` 铁律不变：只有执行成功才标记。

## 十、agentExposed 全链

- 设置页动作表单（`public/js/actions-panel.js` + `actions-panel.logic.js`）：新增「允许机器人调用（同事对话）」勾选，默认开；**勾选 = 省略字段，取消 = 落 `agentExposed:false`**（空字段省略纪律，防覆盖 preset；与 permission 同款处理）。
- `store/action-configs.js` 自由形态存储，字段透传，无需归一改动。
- 欢迎卡片/欢迎文案不变（显式点击路径）。

## 十一、session / prompt 变更

- `session.js`：ctx 增加 `openId`（=colleague.feishuOpenId）与 `chatId`；组装 `actions = listAgentActions(...)` 传入 `buildSystemPrompt`。
- `prompt.js`：新增「## 可用动作」块 + 硬约束补充：
  1. 同事明确要执行操作时才考虑 `run_action`；**执行前复述动作 + 参数，得到确认才调**；
  2. `run_action` 结果**原样如实转述**，不许润色；
  3. 新工具选择指引（报 bug → report_bug；需求变动 → submit_req_change；评审期补充 → supplement_requirement；设计稿 → upload_design_ref；数据问题 → tracking_report；需要主机决策 → notify_host）。
- prompt 测试补断言。

## 十二、注册与进程加载

- `server.js`：`loadPluginSideEffects(['colleague-agent','action-runner','tracking-stats','team-tools'])`。
- 各插件模块加载即注册：`action-runner/index.js` → `import './agent-tools.js'`；`tracking-stats/index.js` 同；`team-tools/index.js` 同（`team-tools/agent-tools.js` 注册 `report_bug`）。
- 「停用即缺席」语义不变。

## 十三、失败语义

| 失败点 | 行为 |
|---|---|
| run_action 脚本失败 | `{ok:false, output}`；模型如实转述；台账已写（undo:null） |
| run_action 参数不全/非法 | `{error, missing}`，不执行；模型追问 |
| tracking_report 后台失败 | tracking-stats 直发失败文案；工具早已返回「已启动」 |
| notify_host 发送失败 | `{error}` 转述 |
| 台账写入失败 | logger.error，fail-open，不影响工具结果 |
| buildUndo 运行时缺席（reversible） | 记 `undo:null` 台账 + logger.error（见 §四） |
| queue 撤回接口异常 | undo 整体失败回 `{error}`，**不 markUndone**（已变动的部分保持真实状态，重试按实际执行） |

## 十四、测试

- 单测：8 个工具各自的 handler（注入 deps）；`agent-tools` 台账 wrapper（成功/失败/undo null 三分支 + mask）；`shared/action-catalog` 纯函数；`undo-agent-action` 4 个新 kind + 2 个既有 kind 回归；`requirement-ops` 队列撤回纯函数；`feature.js` match 判定；`intent` 清理后分类回归；`prompt` 快照。
- 门禁：`npm test` 全绿（当前基线 3789）+ 相关 e2e（`npm run test:e2e -- panels-smoke`）。
- 手工走查（真机飞书）：见实现计划。

## 十五、后续（P5，不在本期）

- web 监管面：按人看对话（agent 会话）、工具轨迹展示（`toolTrace` 已落盘）、一键撤销 UI（路由本期已就绪）、主机飞书卡片推送。
- owner 侧 agent 化评估、群聊多人协作、`postToWeb` 范式抽 shared（现 5 份复制）。
