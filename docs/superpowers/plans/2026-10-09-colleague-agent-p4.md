# 同事侧对话 Agent 化 P4 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或逐任务执行。步骤用 checkbox（`- [ ]`）跟踪。
>
> 前置设计：`docs/superpowers/specs/2026-10-09-colleague-agent-p4-design.md`（先读它，含拍板记录与全部判据）。
> 基线：`npm test` 3789 全绿（2026-10-08）。每个任务完成后跑对应测试；全部完成后跑全套 + e2e。

**Goal:** 完成 2.0 P4——剩余 8 个 agent 工具、通用台账写入器、同事侧旧意图管线退役、撤销四种新 kind。

**Architecture:** 工具仍是「插件模块加载时自注册进 `capabilities/agent-tools.js` 注册表」；台账写入统一在 `buildAgentMcpServer` 的 handler wrapper；同事入口从 intents 白名单改为 `match` 全接；action-runner 意图 feature 摘除但文件留盘。

**Tech Stack:** Node ESM、node:test、zod、飞书 lark.js、store 文件锁。

---

## 任务总览

| # | 任务 | 关键文件 | 依赖 |
|---|---|---|---|
| T1 | `canRunAction` 平移 shared | `src/shared/action-permission.js`（新）、action-runner 引用 | — |
| T2 | 通用台账写入器 | `src/capabilities/agent-tools.js` | — |
| T3 | 动作清单 shared 纯函数 | `src/shared/action-catalog.js`（新） | T1 |
| T4 | `run_action` + action-runner 改造 | `src/plugins/action-runner/agent-tools.js`（新）、`index.js` | T1/T2/T3 |
| T5 | `tracking_report` + chatId 透传 | `tracking-stats/`、`relay.js`、`routes-requirements.js`、`session.js` | T2 |
| T6 | `report_bug` | `team-tools/agent-tools.js`（新） | T2 |
| T7 | colleague-agent 五工具 + 入口 match + prompt | `colleague-agent/tools/*`、`feature.js`、`session.js`、`prompt.js` | T2 |
| T8 | intent.js 清理 action 分支 | `src/app/intent.js` | T7（入口先切） |
| T9 | 撤销四 kind + 队列撤回 + 路由 | `undo-agent-action.js`、`requirement-ops.js`、`routes-*.js` | T2/T7 |
| T10 | 注册清单 + agentExposed UI + 全量回归 | `server.js`、`public/js/actions-panel*.js`、文档 | T4~T9 |

---

## T1：`canRunAction` 平移至 shared

**Files:**
- Create: `src/shared/action-permission.js`（内容=现 `plugins/action-runner/feature/permission.js` 全文，文件头注释加「2026-10-09 自 action-runner 平移：两插件跨用」）
- Modify: `src/plugins/action-runner/feature/index.js`（import 改指 shared）
- Move test: `src/plugins/action-runner/feature/permission.test.js` → `src/shared/action-permission.test.js`

- [ ] Step 1: `git mv` 平移实现与测试（保留 git 历史），改 import 路径。
- [ ] Step 2: `node --test src/shared/action-permission.test.js src/plugins/action-runner/feature/index.test.js` 全绿。
- [ ] Step 3: 全仓 grep `permission.js` 引用，确认无残留旧路径（注释里的文字引用可保留，改为新地址）。

## T2：通用台账写入器

**Files:**
- Modify: `src/capabilities/agent-tools.js`（wrapper 追加成功分支）
- Modify: `src/capabilities/agent-tools.test.js`（三分支 + mask）

- [ ] Step 1: 写失败测试：reversible 成功 → `appendAction` 收到 `{tool, colleagueId, role, msgId, reqId, input(脱敏), ok:true, resultBrief, undo, undone:false}`；safe/notify 不写；handler 返回 `{error}` 不写；handler 抛错不写；external → `undo:null`；buildUndo 返回 null → `undo:null` + error 日志（不抛）。
- [ ] Step 2: 实现。依赖注入 `deps.appendAction` 便于单测；`reqId` 取 `input.reqId ?? ctx.reqId ?? null`；`brief`：`result?.reply` 或 JSON.stringify 截 200；`mask` 用 `store/mask.js`。
- [ ] Step 3: `node --test src/capabilities/agent-tools.test.js` 全绿。
- **注意**：台账写入必须 try/catch fail-open；**不得**影响工具返回值。

## T3：`shared/action-catalog.js`

**Files:**
- Create: `src/shared/action-catalog.js` + `.test.js`

- [ ] Step 1: 纯函数 API：
  - `listAgentActions({ botId, role, getConfigs = getConfigsStore, canRun = canRunAction })` → `{id,name,description,variables,lastVars}` 列表（过滤 enabled!==false、botId 相等、agentExposed!==false、canRun(config, role)）。
  - `renderActionCatalog(actions, { maxChars = 4000 })` → prompt 文本块；每条：`- id　名称：用途\n    变量：label（变量名，必填/可选，示例 x，可选值 a/b；上次使用：脱敏值）`；超长截断 + warn。
- [ ] Step 2: 单测：过滤四种否（enabled/botId/agentExposed/权限）、persistent 值脱敏、渲染截断。
- [ ] Step 3: `node --test src/shared/action-catalog.test.js` 全绿。

## T4：`run_action` + action-runner 改造

**Files:**
- Create: `src/plugins/action-runner/agent-tools.js` + `.test.js`
- Modify: `src/plugins/action-runner/index.js`（features 清空 + `import './agent-tools.js'` + 退役注释；card-action import 保留）
- Modify: `src/plugins/action-runner/feature/index.js` 文件头加退役说明（顶层注释即可，不改逻辑）

- [ ] Step 1: 失败测试：
  - 注册 def：name `run_action`、danger external、roles `['*']`、`exposedFlag:'agentExposed'`。
  - handler：未知 id → error；`agentExposed:false` → 拒；`permission:'owner'` 的动作 guest 调用 → 拒；缺必填 → `{error, missing}` 且**不执行**；enum 越界 → error；成功 → `{ok:true, output, target}` 且调用了 `runAction`（注入桩）；persistent 存量合并 + `setVar` 调用。
- [ ] Step 2: 实现（依赖注入 `getConfig/listUserVars/runAction/saveVar`；`pickMissingVars`/`resolveVariable` 从同插件模块 import；`describeTarget` 复用）。
- [ ] Step 3: `node --test src/plugins/action-runner/agent-tools.test.js src/plugins/action-runner/index.test.js`（index 测试如有 feature 注册断言需同步改）。
- **注意**：`index.js` 的 `features: []` 会让既有的 `index.test.js`（如断言 order 30）失败——按新契约更新（断言只剩 card/tool 副作用或显式断言空数组）。

## T5：`tracking_report` + chatId 透传

**Files:**
- Modify: `src/plugins/tracking-stats/freeform.js`（抽 `startFreeformQuery({text,userId,chatId,reply,ack,logTag})`；handle 改为薄壳）
- Create: `src/plugins/tracking-stats/agent-tools.js` + `.test.js`
- Modify: `src/plugins/tracking-stats/index.js`（`import './agent-tools.js'`）
- Modify: `src/plugins/colleague-agent/relay.js`（payload +`chatId`）
- Modify: `src/plugins/colleague-agent/feature.js` + `src/entrypoints/feishu/index.js`（附件分支）传 `chatId: ctx.sessionKey` 给 relay
- Modify: `src/entrypoints/web/routes-requirements.js#handleColleagueAgentTurn`（透传 chatId，string/可空校验）
- Modify: `src/plugins/colleague-agent/session.js`（input 收 chatId → ctx.chatId）
- 相关测试同步

- [ ] Step 1: 抽 `startFreeformQuery`（不改行为；现有 freeform 测试全绿）。
- [ ] Step 2: 写 tool：safe、roles `['ops','product']`、schema `{question}`；限流 → `{error}`；成功启动 → `{started:true, note}`；`reply` 适配器直发（注入桩断言）。
- [ ] Step 3: chatId 全链透传 + 各层测试更新（relay 断言 payload；route 断言透传；session 断言 ctx）。
- [ ] Step 4: `node --test src/plugins/tracking-stats src/plugins/colleague-agent src/entrypoints/web/routes-requirements.test.js` 全绿。

## T6：`report_bug`

**Files:**
- Create: `src/plugins/team-tools/agent-tools.js` + `.test.js`
- Modify: `src/plugins/team-tools/index.js`（`import './agent-tools.js'`）

- [ ] Step 1: 失败测试：注册 def（reversible、roles `['*']`、buildUndo → `{kind:'discard-task', taskId}`）；handler 调 `createTask({type:'bug',...})` + `requestAutoDevelop(taskId)`（注入桩）；回执含任务标题。
- [ ] Step 2: 实现（import `store/tasks.js` + `./auto-dev/queue.js`，同插件，无跨插件依赖）。
- [ ] Step 3: `node --test src/plugins/team-tools/agent-tools.test.js` 全绿。

## T7：colleague-agent 五工具 + match + prompt

**Files:**
- Modify: `src/plugins/colleague-agent/tools/req-read.js`（+`get_ui_spec`，更新 `REQ_READ_TOOL_NAMES`）
- Modify: `src/plugins/colleague-agent/tools/req-write.js`（+`submit_req_change`/`supplement_requirement`/`upload_design_ref`，更新工具名清单）
- Create: `src/plugins/colleague-agent/tools/host.js`（`notify_host`）
- Modify: `src/plugins/colleague-agent/index.js`（注册 host 工具）
- Modify: `src/plugins/colleague-agent/feature.js`（改 `match` 全接；`intents: []`）
- Modify: `src/plugins/colleague-agent/session.js`（ctx +openId/chatId；组装 actions 清单传 prompt）
- Modify: `src/plugins/colleague-agent/prompt.js`（「可用动作」块 + 新硬约束）
- 测试同步（req-read/req-write/feature/prompt/session）

- [ ] Step 1: 逐工具写失败测试（可见性 fail-closed / 阶段校验 / 文件按名反查 / 回执文案 / buildUndo 形状）。
- [ ] Step 2: 实现（动态 import `requirement-ops.js` 的 `readMapVersion/writeMapVersion/enqueueSystemTask` 等；`mergeFigmas` 从 `entrypoints/web/req-map.logic.js`；`readUiSpec` 从 `entrypoints/web/req-uispec.js`（按实际模块名））。
- [ ] Step 3: feature match 测试：名册内 → match 真；非名册 → 假；owner → 假；handle 不再依赖 intentResult。
- [ ] Step 4: prompt 快照：含动作块（注入假清单）与三条新约束。
- [ ] Step 5: `node --test src/plugins/colleague-agent` 全绿。

## T8：intent.js 清理 action 分支

**Files:**
- Modify: `src/app/intent.js` + `src/app/intent.test.js`（及 dispatch 相关测试如受影响）

- [ ] Step 1: 删除 L2 动作关键词、L3 action 候选/判定、`via/actionId/actionName`、L1 question 绕行。
- [ ] Step 2: 更新测试：删 action 用例；补「含动作关键词的文本按普通分类处理」回归。
- [ ] Step 3: `node --test src/app` 全绿；`npm test` 检查无其它依赖 action intent 的用例（预计 action-runner/dispatch 测试有波及，逐一按新契约更新）。

## T9：撤销四 kind + 队列撤回 + 路由

**Files:**
- Modify: `src/store/agent-actions.js`（UNDO_KINDS +2） + `.test.js`
- Modify: `src/entrypoints/web/undo-agent-action.js` + `.test.js`
- Modify: `src/entrypoints/web/requirement-ops.js`（队列撤回导出 + 纯函数） + `.test.js`
- Modify: `src/entrypoints/web/routes-requirements.js`（`POST /api/req/agent-action/undo`）+ `.test.js`

- [ ] Step 1: UNDO_KINDS 加 `remove-supplement`/`remove-figma`；store 测试更新。
- [ ] Step 2: 队列撤回纯函数：`takeQueuedTask(queue, reqId, kind, match)`（返回 `{queue, removed, mutated}`，不改原数组——可测）；`requirement-ops.js` 薄壳 `dropQueuedSystemTask` / `mutateQueuedSystemTask` 调用之。
- [ ] Step 3: undo 四分支 + 测试（成功/下游已发生回执/任务状态机三分支/队列已派发不动）。
- [ ] Step 4: 路由 + 测试（404/成功/失败不 markUndone 断言）。
- [ ] Step 5: `node --test src/store/agent-actions.test.js src/entrypoints/web/undo-agent-action.test.js src/entrypoints/web/requirement-ops.test.js` 全绿。

## T10：注册清单 + agentExposed UI + 全量回归

**Files:**
- Modify: `src/entrypoints/web/server.js`（`loadPluginSideEffects([...4 插件])`）
- Modify: `public/js/actions-panel.js` + `actions-panel.logic.js`（勾选 + 空字段省略）+ 现有测试
- Modify: 各模块 `CLAUDE.md`（条目更新）+ `docs/superpowers/roadmap.md`
- 全量：`npm test`、`npm run test:e2e`

- [ ] Step 1: server.js 加载清单 + 冒烟（加载后 `listAgentTools()` 数量断言可用脚本验证）。
- [ ] Step 2: 表单勾选（默认开；勾选省略、取消落 false）+ 逻辑单测。
- [ ] Step 3: 文档同步（plugins/CLAUDE.md 的 colleague-agent / action-runner 条目、entrypoints/CLAUDE.md 的 undo/路由、roadmap 打勾）。
- [ ] Step 4: `npm test` 全绿（基线 3789 + 本期待增）；`npm run test:e2e -- panels-smoke`；`node --test "src/**/*.test.js"` 等按 package.json 实际脚本执行。
- [ ] Step 5: 手工走查清单（真机飞书，维护者执行）：
  1. 同事发「帮我退款 test 环境 138xxx」→ agent 复述确认 → 确认后执行 → 台账 `undo:null`；
  2. 同事报 bug → 任务入队 → 面板可见；
  3. 产品发「需求变动：XXX」→ changes 落盘 + 地图更新（有图时）；
  4. 设计发 figma 链接 → 地图页出现引用 → curl 撤销路由生效；
  5. 外部账号（非名册）发含动作关键词的文本 → 不再触发脚本，回落引导文案；
  6. 同事发普通消息延迟（match 省一次分类调用，应不劣于 P3）。

---

## 自检清单（开工前）

1. 设计稿 §四/§六/§七/§九 的每个判据都有对应任务与测试。
2. 台账 wrapper 的「失败不写 / undo null 降级 / fail-open」三条在 T2 测试里逐条钉住。
3. 退役是「摘注册 + 留盘」而非删文件；card-action 路径全程不受影响（T4/T8 回归）。
4. 所有工具 handler 的三处纪律照旧：fail-closed 可见性、不倒整条记录、不给绝对路径/下游原文错误。
5. 不自动 git 提交；改动留工作区。

---

## 实施状态（2026-10-09 收官）

**T1~T10 全部落地**。验收：`npm test` **3877 全绿**（基线 3789，本期待增 88）；`npm run test:e2e` **14/14 通过**。

实施时相对设计稿的三处调整（均已落进代码与模块地图注释）：

1. **台账「骨架 + 覆盖」→ `selfLedger` 跳过即时写**（T2）。原设计让 wrapper 先写骨架、onSettle 覆盖式补全；实施时判定骨架会让「无代码改动 / run 失败」的任务留下撤不出任何东西的假记录，改为 `start_dev_task` 标 `selfLedger:true`，锚点唯一生产者是 `colleague-dev.js`。
2. **`__private` 约定**（T2/T7）。撤销锚点（taskId/supplementId/figmaId）是 handler 当场生成的，模型拿到没用还可能复述；约定 `result.__private` 给 `buildUndo` 读，wrapper 在 `textResult` 前剥掉。
3. **`resolveVariable` + PRESETS 平移到 `shared/action-vars.js`**（T3）。与 `canRunAction` 同一理由：`shared/action-catalog.js` 不能向上 import 插件层；`var-contract.js` re-export 兼容既有引用。

新增台账测试专文件 `src/capabilities/agent-tools.ledger.test.js`（11 例）；`agent-tools.test.js` 保持原样（长文本追加有编码风险，拆分反而更聚焦）。
