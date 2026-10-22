# src/entrypoints · 模块地图

> 本目录是「渠道 → 业务」之间的**组装层 / 传输层**：把不同来源（web HTTP、飞书长连接、控制台）的入站，拼成统一 `ctx` 或 `run` 再往下交。改动前先认准一个分野——
>
> **`console/` 与 `feishu/` 走 `app/dispatch`**（意图识别 → feature 路由），各自只有一个 `index.js`；**`web/` 不走 dispatch**（`server.js` 注释：web 恒为本机 owner，聊天直连 provider 流式，避免 dispatch 的流式阻抗）。这就是为什么 `web/` 目录这么重、而另两个入口各一个文件——web 把「起跑 / 收尾 / 续跑 / 审批 / SSE」这套 dispatch 不管的编排全揽在了自己身上。架构全景见仓库根 `docs/ARCHITECTURE.md`。

## 一、文件清单

### 非 web 入口（走 dispatch）
- `console/index.js` — 控制台入口：console 渠道收行 → 组装统一 `ctx` → `dispatch`，本地调试意图/feature 全链（`CONSOLE_ROLE=guest` 可模拟访客）。
- `feishu/index.js` — 飞书入口：channel 收信 → 角色判定 / 群聊 @ 过滤 / 图片文件材料池 / 云文档拉取等业务特例 → `ctx` → `dispatch`；导出 `registerCardActionHandler`（卡片回调注册）。

### web 入口：核心骨架
- `web/server.js` — web 真入口：建 HTTP server、**有序 ROUTES 路由表**、CORS、访问日志；`listen` 回调里启动各泵并做崩溃恢复；导出 `ready`（listen 完成的 Promise，供一体化入口先起 web 再挂飞书）。
- `web/route-match.js` — 路由表匹配（`matchRouteFrom`）与启动自检（`findShadowedRoutes`）；纯逻辑，不碰 req/res、不引用任何 handler（这样测试无需真起服务就能钉住分发契约）。
- `web/origin.js` — CORS 来源裁决：把 `Access-Control-Allow-Origin` 从 `*` 收窄为白名单（`isAllowedOrigin` / `checkOrigin`）。
- `web/http-util.js` — 共享 HTTP 工具：`sendJson`。
- `web/body.js` — 请求体读取收口：`readJsonBody` / `withJsonBody`（替代散落在 routes-* 的裸 `req.on('data')`）。
- `web/input.js` — HTTP 边界输入卫生：`normalizeMode`（权限模式白名单 fail-closed）/ `str` / `safeDecodeId`。

### web 入口：run 执行编排（核心）
- `web/routes-run.js` — run 相关端点 handler：起跑 / 停止 / 决策 / 插话（持有缓冲）/ 切模式 / 待续跑 / SSE 附加；含记忆库用户输入埋点（`logUserText`，只认前端 `userTyped` 标记）与提交幂等认领（`requestId` → runId/msgId 回放，认领表在 `store/submissions.js`）。**T2-P4 busy inbox → queue-first（2026-10-16）**：`/start` 撞上同会话运行中 run 时不再新起，按能力路由进 inbox（`queueIntoBusyConv`，响应 `queued:true`+`mode`）——**默认落 follow-up 队列**（`steer` 让位为显式动作）；`/send` 同口径；`/msg/now` 带 `msgId` → `steerQueuedNow`（排队项转持有并立即投递，失败码 `not_ready`/`input_closed`/`gone` 供前端给准话术），缺 msgId 保留旧「flush 全部持有 + 打断」语义；`/msg/withdraw` 持仓中/排队项；新增 `GET /api/run/queue?convId=`（排队卡片条数据源：held(mode:steer) + queued(mode:queue) + 当前 runId）；`/api/run/pending` 的 `followUps` 带 `texts`（排空上屏用）。
- `web/run-claude.js` — **Claude run 编排核心**：`startClaudeRun`（装 SDK 回调 / canUseTool 审批 / onUserDialog；注入内置 MCP（SDK `mcpServers`）与内置 Skills（SDK `plugins` 本地插件）、**委托同事对话 MCP**（`capabilities/feishu-ask-sdk.js`，`mcpServers['feishu-ask']`，`readOnlyExtra` 放行等待工具）；置 `capabilities.steer=true` + `followUp=true`（queue-first：默认排队，显式「立即发送」才 steer））、`settleRun`（收尾 + 额度续跑 + 异常重试）、`doResume`、`reconcileRuns`（P5 启动对账：run-index 孤儿统一归类 → Claude 写 pending / openai 排程 / 熔断 / 摘除；`recoverPendingAndOrphans` 为其外层入口，负责再重排 pending 定时器）。`settleRun` 与 `doResume` 互相调用，**必须同文件**。**工具策略（T6）**：`canUseTool` 走 `capabilities/tool-policy` 统一规则表——交互档位实时读 `run.mode`，无人值守按 `execPolicy`+`unattended` 解析；PreToolUse 钩子由 `buildClaudePretoolHook` 动态装配（default 恒 ask 交回 canUseTool；bypass 档 deny 名单守卫兜底——SDK 在 bypass 不调 canUseTool；acceptEdits/plan 不表态）；危险命令全档 deny、无人值守策略拒绝计次达 3 → `stopRun` + `systemNotify`（`policy_block` journal 事件）。**任务清单持久化（P1-9）**：起跑时读 `store/conv-todos.js#getConvTodos`，把 `renderPlanSection` 追加进 `systemPrompt.append` 尾部（**每轮都注入**，压缩丢调用也不失忆）；`run.todos` 的面板续挂（`hydrateRunTodos`）只在**续跑**时做——判据 `run-claude.logic#isContinuationRun`（`resumePendingId` / `resumeAttempt`），新起一轮不预挂上一轮的旧清单（2026-10-16 修订，见 P1-9 spec §8）。
- `web/run-claude.logic.js` — run 编排纯判定层（零 IO）：`isRetryEligible` / `runIdsToAbortOnDismiss` / `isResumePlanned` / `MAX_RESUME_ATTEMPTS`（本体全是 SDK 调用与落盘，无法直测，判定抽这里）。
- `web/run-reconcile.logic.js` — 启动对账归类纯函数（P5）：`classifyInterrupted(indexEntry, journalTail)` → `resume | abandon | discard` + 理由；只看 index 锚点与 journal 事实（settled 残留、session/convId 锚点、attempts 超限）。
- `web/run-openai.js` — openai-compat run 编排：`resolveCredential`（凭证按 credId>model>兜底 定位，防多厂商串台；**多模型（OpenCode 式）**：by-model 在 `credentialModels(t)` 的发现列表里找，legacy 单 model 自动回落）+ 内置文件/命令工具打底（`providers/builtin-tools.js`）+ 命令会话管理（`providers/exec-sessions.js`，P1-6：`exec_command`/`write_stdin`/`list_processes`/`kill_process` 长任务 start+poll，run 收尾 `terminateAll`；UI 一行开关 `exec_command` 管整族）+ 仓库地图注入（`features/repo-map`，受 `repoMap.enabled` 开关，默认开）+ 委托同事对话（`capabilities/feishu-ask-tools.js`，提问走审批/等待免审批）+ 可选 MCP 增强 + 每工具审批（内置只读且在工作目录内自动放行）+ 系统提示词注入；无 Claude session，历史走 conv-messages 重放。**检查点续跑（T2-P3）**：每步消息经 `onMessages` 落 conv-messages（即检查点）、run-index 登记；载入历史与构建请求前各跑一遍发送前 normalize（`capabilities/context-normalize.logic.js`：悬空合成「未执行」落盘、孤立清理、剪空、单条截断；P0-③），`resumeOpenAiRun` **不追加「继续」**、直接从现场续；孤儿编排（P5）由 `reconcileRuns` 统一调用 `scheduleOpenAiOrphanResume` 排程。**busy inbox（T2-P4 → P1-10 步边界 steer → 2026-10-16 queue-first）**：起跑/续跑置 `capabilities.steer=true` + `steerMode='step'` + `followUp=true`（默认排队；显式「立即发送」才 steer）与 `run.cwd/model/credId/effort` 快照（`buildFollowUpItem` 取它做排空上下文），hooks `takeSteerMessages`/`shouldPreempt` 接 `agent-loop`——持有消息在步边界并入对话、本轮无可见产出时到达即抢占（spec 2026-10-11-openai-step-steer-design）。**工具策略（T6）**：`canUseTool` 同走 `capabilities/tool-policy` 统一规则表（档位=`run.mode`，routes-run 与 chat.js 现已透传 mode；缺省 default = 非白名单全问，与改动前等价）；Bash 执行后端按 `settings.exec` 解析（local/container；引擎不可用 fail-closed）。**上下文压缩（T7；P0 双触发）**：`runOpenAiSession` 开头按**条数 >200 或估算 token 达窗口 90%**（`capabilities/context-budget.logic.js`，窗口未知只认条数）触发滚动摘要（同凭证一次性零工具调用，fail-open），保留窗口按 token 预算收缩（`resolveKeepRecent`，不低于 20 条）；模型视角 = system(含摘要) + 近期视图；原文保留在 conv-messages，磁盘 backstop 见 `store/conv-messages.js`；每次压缩落 `compaction` journal 事件（口径/前后估算/切点），每步用量落 `usage` 事件（`store/runs.js#runUsage`，只记数字）；压缩/估算消费的都是发送前 normalize 洗净后的视图（P0-③，`capabilities/context-normalize.logic.js`，载入与构建请求两处执行）。**任务清单持久化（P1-9）**：起跑时读 `store/conv-todos.js#getConvTodos`，把 `renderPlanSection` 追加在 system 尾部（摘要段之后，**每轮都注入**）——压缩丢掉早期 TodoWrite 调用后模型仍知道自己的计划；`run.todos` 的面板续挂（`hydrateRunTodos`）只在**续跑**时做（`resumeOpenAiRun` 传 `continuation: true`；新起一轮与排空都不预挂旧清单，2026-10-16 修订，见 P1-9 spec §8）；TodoWrite 快照经 sink 落盘，即下一轮的注入源。**模型流重试（P0-④）**：每步模型请求（含强制收尾轮）失败在**循环内**退避重试（决策在 `providers/model-retry.logic.js`：白名单判定 + 默认 5 次/2s 起步/60s 封顶；120s 无任何流事件判死并重建请求），仅在**未向用户输出过内容**时重试；`hooks.onRetry` → `model_retry` journal + 活动行「⏳ 模型流中断（类型），N 后重试（第 n/N 次）」（子代理只上活动行、不写 journal）。**强度（composer-bar）**：`effort` 随起跑/续跑透传 → provider `input.effort` → openai-compatible `reasoning_effort`（无档位模型为 null，摘要调用不带）。**工具循环预算（2026-10-08 空输出事故）**：默认 **无上限**（`uiPrefs.openaiMaxSteps` 经 `resolveMaxSteps` 解析：0/空/非法=∞，同 Claude Code/OpenCode；基础设置可配正整数）。设限且用尽时 agent-loop 走**强制收尾**（禁工具 + 总结；runActivity 提示「已让模型收尾总结」），不再静默截断；完成/空回复/失败/收尾均落日志（runId/steps/tokens/err）。**模式实时生效（A6）**：策略门 `level` 为**函数**（实时读 `run.mode`）——`/api/run/set-mode` 对 openai 四档中途可切（`setRunMode` 放宽时顺手放行挂起审批）；续跑从 run-index 恢复 `entry.mode`、排队排空带 `first.mode`；journal/日志记录真实 mode。**联网/清单/子代理（A7）**：装配 `capabilities/web-tools`（WebFetch/WebSearch，搜索配置读 `settings.search`）与 TodoWrite（onActivity → `runTodos` 任务面板）、Task（只读子集 `subagent.logic.js`、审批复用主门、结论回灌；禁递归）。**子代理句柄（P1-7）**：`capabilities/agent-registry.js`（per-run，注入 `runTurn` = `callAgentTurn`）把每个子代理登记成有 id/名字/状态/邮箱/历史的实体——`Task({background:true})` 后台派发（立即返回 `agent_id`）、`send_message`（空闲起新一轮/运行中入邮箱当前轮结束自动接续）、`wait_agent`（默认 30s，超时如实回「仍在运行」并打心跳）、`interrupt_agent`（只切这一份，历史保留）、`list_agents`；Workflow 的子任务同样登记（`provider=workflow-step`）；状态迁移落 `agent_status` journal 事件（回放 reducer 有 `agents` 车道）；run 收尾 `settleAll`（60s 后 abort 并如实告知）→ `finally` 里 `interruptAll`；四个工具逐个有开关，关掉 `send_message` = 后台派发一并停用（没有取回手段就不后台跑）。
- `web/conv-compact.logic.js` — 上下文压缩纯函数（T7；P0 双触发）：`shouldCompact`/`pickCompactCut`/`resolveKeepRecent`（条数阈值 + token 感知保留窗口 + user 整轮边界切点 + minDrop）、`formatMessagesForSummary`/`buildSummaryPrompt`/`SUMMARY_SECTIONS`（转录格式化与四要素滚动摘要 prompt：进度/约束/待办/数据）、`composeSystemWithSummary`。token 估算与阈值判定在 `capabilities/context-budget.logic.js`（依赖方向向下，本层只消费布尔量）；消息序列不变量与 `clipMiddle` 已随 P0-③ 迁至 `capabilities/context-normalize.logic.js`。
- `web/provider-models.js` — 服务商模型列表拉取运行时（设置页「添加即发现」/「刷新模型」）：GET `{base}/models` + Bearer(可空) + 10s 超时 + 流式 1MB 上限 + 人话错误（鉴权/404/超时/格式）；`fetchImpl/timeoutMs/maxBytes` 可注入（测试零网络）。
- `web/provider-models.logic.js` — 上者纯函数层：`modelsEndpoint`（拼接/协议/幂等）、`extractModels`（OpenAI 标准/`models[]`/裸数组；去重保序、上限 300；**effort 元数据** `effort.supported_levels`/`default_level` → `efforts`/`defaultEffort`）。
- `web/run-openai.logic.js` — openai 编排纯函数层（零 IO）：`resolveMaxSteps`（工具循环步数上限归一）。悬空 tool-call 修复已随 P0-③ 泛化为发送前不变量集，见 `capabilities/context-normalize.logic.js`。
- `web/run-durability.js` — run 生命周期落盘接线（P5：run-index 唯一来源）：注册 journal sink（`store/runs` 事件 → `store/run-journal`）+ 锚点写 `run-index`（`mirrorRunStart/Patch/Remove/RunsRemove`）；`startRunDurability()` 幂等，由 `server.js` 在 listen 回调调用；写失败一律吞掉（尽力而为，不改主链语义）。旧 `active-runs.json` 一次性迁移在 `store/run-index.js#migrateLegacyActiveRuns`（由 reconcileRuns 调用）。
- `web/conv-inbox.js` — busy inbox 排空（T2-P4）：`startConvInbox()` 注册 settle 监听，run 终结且该 conv 有 follow-up → 从快照起下一轮（多条合并一轮；`findRunningRunByConv` 并发守卫保证同会话永不并发；起跑失败对占位 run 走 `failRun`）；`drainFollowUps` 支持 deps 注入便于单测。**queue-first（2026-10-16）**：Claude 排队项也走此排空（不再是 steer 兜底路径）；`markFollowUpStarted` 带 `texts`（前端接流时在助手占位前上屏用户消息）；Claude 分支 mode 同取「排空时刻 run 最新值」。**P1-9 启动恢复**：`restoreFollowUpInbox()`（server.js 在 `startConvInbox()` 后、启动对账之后调用）hydrate 落盘队列（`store/conv-followups.js`）并对**空闲** conv 补排空——覆盖「run 已终结但队列尚未排空就崩了」的窗口（那份队列没有终结口可等）；有 running run 的 conv 交给它的终结口，不抢跑；读盘失败按无队列继续。
- `web/tier.js` — auto 档位判定：`quickTier`（关键词快判）+ `classifyTier`（Haiku 极速分类），自动选 model/effort 省额度。
- `web/tool-summary.js` — 共享纯函数：`summarizeTool`（工具调用摘要）/ `parseDialog`（onUserDialog payload 解析）。（原 `READONLY_TOOLS` 放行集已随 T6 收归 `capabilities/tool-policy.logic.js` 统一规则表。）

### web 入口：需求工作流
- `web/routes-requirements.js` — 需求工作流 HTTP 单入口 `handleRequirementRoutes`，按 pathname+method 内部分发；`colleague-agent/turn` 会在同事对话 agent 之前截获「委托提问」的答复（`capabilities/feishu-ask.js#handleColleagueAskReply`）；「问同事」卡片另有 `/feishu-ask/answer`（同事点飞书卡 → `handleColleagueAskOption`）与 `/feishu-ask/confirm`（主机点 web 卡 → `confirmAskFromHost`）两端点。
- `web/routes-req-v2.js` — 需求 v2 路由：问卷 / 需求地图 / 需求变动 / UI 规范（`handleReqV2Routes`）。
- `web/requirement-ops.js` — 需求工作流编排：docgen、**系统任务串行闸泵**（`startRequirementPump`）、busy 崩溃恢复与泄漏自愈（`healStaleBusy`）；直调 `startClaudeRun` 与 `integrations/claude` 的 `runClaude`。
- `web/req-logic.js` — 需求纯逻辑（零 IO）：prompt 构造 / 文档解析 / BUG 判决映射 / 档案拼装。
- `web/req-map.logic.js` — 需求地图纯逻辑：LLM 输出解析 / 地图规范化 / 修订 prompt。
- `web/req-quiz.logic.js` — 评审期问卷纯逻辑：prompt / 解析 / 答案回注。
- `web/req-uispec.logic.js` — UI 规范纯逻辑：还原 prompt / 规范草稿 prompt。
- `web/req-inspect.js` — 测试期 bitable 巡检（复用 \10001 基建：bitable API / 字段映射 / 评审门）。
- `web/req-pitfalls.js` — 避坑清单读写：`.claude/pitfalls.md` 与 `CLAUDE.md`。
- `web/colleague-dev.js` — 系统任务 `colleague-dev` 执行侧（`plugins/colleague-agent/tools/req-write.js#start_dev_task` 的执行端）：`dispatchColleagueDev`（新建 `kind:'sub'` 子会话 + 新 session 上下文 + `bypassPermissions`，**busy 带 convId**）、`buildColleagueDevOnSettle`（清 busy / 回填 sessionId / `markHandled` / 回飞书简报 / 写撤销台账）、`abandonColleagueDev`、`replyColleague`（简报按 `route.chatId/chatType` 回来源会话：群里发起回群里并 @ 他，路由判定用 `shared/reply-target.js`；入队 payload 里的 chatId/chatType 由 `start_dev_task` 从 agent ctx 带上）。**不得 import `requirement-ops.js`**（成环）；纯函数层已独立为 `web/colleague-dev.logic.js`，二者可各自单测。
- `web/colleague-dev.logic.js` — 上者的零 IO 纯函数：`newSubConvId`（服务端子会话 id 生成，与前端 `createReqConv` 的 id 空间天然不撞）、`buildBrief`（回同事的简报文案，按字符而非 UTF-16 码元截断，防 emoji 从代理对中间被切开）。是上一代四期分类器管线（`colleague-auto.logic.js`，已随管线整体下线）里唯一还在用的部分，随真正的消费方搬到这里。

### web 入口：体检 / 优化
- `web/routes-optimize.js` — 项目优化 HTTP 接口（单入口范式，对齐 routes-memory）。
- `web/optimize-ops.js` — 体检 / 优化编排：静态维度同步出结果、两个 LLM 维度后台**并行**跑经 SSE 回填；**不复用** `store/runs` 的 run 注册表，只借它的 `sendTo` 发 SSE。

### web 入口：会话飞书通知
- `web/routes-conv-notify.js` — 会话飞书通知路由（未命中回 `false`，交回 server.js 继续匹配）。
- `web/conv-notify.js` — 在 `store/runs` 注册**终结监听器**推私聊卡片；`injectToConv` 把飞书补充内容注入回原会话。**T2-P4**：运行中注入按能力进 inbox（Claude → steer 持有；openai → follow-up 排队；两者都无 → 409 拒绝），不再直接起并发 run。**2026-10-16 备注**：web 侧已改 queue-first 默认排队，但飞书注入**保持 steer 优先**（bot 侧没有排队卡片可操作）；若需两端统一另开 spec。
- `web/conv-notify.logic.js` — 会话通知纯函数：`shouldNotifySettle` / `summarize` / `buildConvSettledCard`。

### web 入口：其它路由 handler
- `web/routes-settings.js` — 设置 / 导入导出 / token 轮换 / openai-compat 凭证 / MCP server / 内置能力（`/api/builtins`：内置 MCP 开关与密钥、Skills 清单）/ 插件启停；`/api/settings` 的 section 分区还含 memory-bank、repo-map、**exec（Bash 执行后端，T6；设置页「Bash 执行后端（自定义模型）」段落即其 UI，2026-10-11 落地）** 与 **search（联网搜索 provider+key，A7，仅 openai 路径 WebSearch 用）**；机器人 CRUD 含 **execPolicy（无人值守执行档位，T6）**。**凭证多模型（OpenCode 式）**：`POST /api/credentials` 不再要求 model（返回 `credential.id`）；`POST /api/credentials/:id/refresh-models` 拉取 `{base}/models` 并落 `models/modelsUpdatedAt`；`GET` 出归一后的 `models`（legacy model 回落）。
- `web/routes-files.js` — 上传 / 目录浏览 / 系统选目录 / 常用目录 / 脚本上传 / 静态托管；含 `validateScriptName`、路径防穿越。
- `web/routes-ops.js` — 日志 / 任务 / 历史 / 动作配置 / 脚本列举 / 启动初始化（`initializeDefaults`）/ ping / notify。
- `web/routes-memory.js` — 记忆库 HTTP 接口（单入口范式）。
- `web/routes-colleagues.js` — 同事名册 CRUD（单入口范式）。单条 prefix 覆盖 `/api/colleagues` 与 `/api/colleagues/:id`。
- `web/routes-patrol.js` — BUG 巡检循环的 `/api/patrol/start|stop`（单入口范式）。只服务 feishu 进程的跨进程调用：循环泵在 web 进程（要读 auto-dev 任务终态判「全修完」），而 `\10001`/`\10004` 指令在 feishu 进程收。`start` 有单例约束，冲突回 409 并带启动人与时间。

### 纯逻辑层 & 测试
- `web/*.test.js`（`body` / `origin` / `input` / `route-match` / `run-claude.logic` / `run-openai.cred` / `tool-summary` / `req-*` / `routes-*` / `colleague-dev` / `colleague-dev.logic` 等）— 与同名源文件配对的 `node --test` 单测。分发层（route-match）与各 `*.logic.js` 的契约靠这批测试钉住，因为编排本体全是 SDK/落盘/`server.listen`，无法直测。
- **fs 级集成**（`run-openai.resume.test.js` / `run-openai.workflow.test.js` / `run-openai.snapshot.test.js`）：临时 `APP_DATA_DIR` + 同 id 覆盖假 provider，内部跑真 run-openai / 真 normalize / 真压缩，只把最外层模型调用换成脚本。**发送面快照（P1-12）**：`run-openai.snapshot.test.js` 逐次捕获「模型实际收到的 messages + 本轮工具名集合」写进 `web/__snapshots__/run-openai-requests.json`（normalize 规则：临时路径 `<DATA>` / 平台名 `<OS>` / 时间戳 `<TS>` / >4000 字符压缩为 `$len`+头尾），锁住 P0 上下文组装的回归。快照不符时按失败信息重录：`UPDATE_SNAPSHOTS=1 node --test src/entrypoints/web/run-openai.snapshot.test.js`（Windows PowerShell：`$env:UPDATE_SNAPSHOTS=1; node --test ...`）。

## 二、关键流程

### A. web 聊天起跑（主路径）
浏览器 `POST /api/run/start` → `web/server.js` 用 `route-match.js` 命中 ROUTES 表 → `web/routes-run.js` `handleRunStart`：读 body（`body.js`）、归一 mode（`input.js`）、`model='auto'` 时经 `tier.js` `classifyTier` 判档 → `createRun`（`store/runs`）→ 按 provider 分流：
- **Claude**：`web/run-claude.js` `startClaudeRun` → `providers/claude-agent` SDK；回调经 `store/runs` 广播 SSE，`canUseTool` 审批走 `askUser`，工具文案走 `tool-summary.js`，`onUserDialog` 走 `parseDialog`。
- **openai-compat**：`web/run-openai.js` `startOpenAiRun` → `resolveCredential` 定凭证 → 内置工具 + 委托同事对话 +（可选）连 MCP → `providers/openai-compat`。
  Ultracode（`data.ultracode` 透传，A11）：开着才注入自研的 `Workflow` 工具（`capabilities/workflow.logic.js`，逐阶段并行跑只读子代理）并在系统提示末尾追加授权说明；未授权时工具不存在，`executeTool` 里还有一道 fail-closed。

前端另发 `GET /api/run`（`handleRunAttach`）建 SSE 接流；**关网页只退订、不中断 run**——run 是独立于连接的服务端状态。

### B. run 收尾与自愈闭环（run-claude 的重头）
SDK `done` → `settleRun` 三条出口：
1. **额度耗尽**（rateLimit rejected）→ `addPending` 登记待续跑；有健康备用号 → `doResume` 立即续跑，否则 `scheduleResume` 等 token 重置后续跑。
2. **异常结束** → `isRetryEligible`（`run-claude.logic.js`）判定够格 → `scheduleRetry` 2 秒后 `doResume`，代次 +1、达 `MAX_RESUME_ATTEMPTS` 熔断。
3. **正常/超限** → `finishRun`/`failRun` + 触发 `run.onSettle`（需求系统任务的串行闸收尾钩子唯一汇聚点）。

进程重启后，`server.js` 的 `listen` 回调调 `recoverPendingAndOrphans` → `reconcileRuns`（P5）：读 run-index（多实例共用数据目录时只回收「属主已死」的条目），对每条孤儿读 journal 用 `classifyInterrupted` 归类——Claude 写 pending 排程、openai 直接排程检查点续跑、熔断/无锚点落 abandoned、settled 残留摘除；随后统一重排 pending 定时器。

### C. 飞书 / 控制台入站（走 dispatch，不进 web run 编排）
channel 收信 → `feishu/index.js`（群聊只处理 @ 机器人；图片/文件归一化为材料挂近期任务或入池；云文档链接拉取存材料）或 `console/index.js` → 组装统一 `ctx`（`source/user/text/sessionKey/reply/meta`）→ `app/dispatch`。飞书裸 dispatch 换成 `dispatchSafely`，避免抛错让用户「表情贴上又取下、再无下文」。

**「正在处理」表情标记**（2026-10-14）：入站时贴、**跟着这条消息的终态答复摘**，不跟 dispatch 返回走（旧实现会让异步流程的标记"出现一下就消失"，见 `shared/processing-mark.js` 文件头）。三条形态：同步流程 `settle()` 即摘；进程内异步流程（feedback 分析/评审、tracking-freeform 后台查询）在 `ctx.meta.processing.hold(promise)` 续命；跨进程同事对话 `transfer()` 把摘除凭据（feishuMessageId + reactionId）随 relay payload 交给 web，由 `routes-requirements.js#clearProcessingMark` 在本轮结束时摘。标记有 15 分钟兜底上限（进程卡死/远端没摘时强制摘除）。新增「dispatch 返回后还在跑」的流程必须选一种形态，否则会复现同一 bug。

### D. 会话飞书通知闭环
`server.js` `listen` 调 `startConvNotify` 注册终结监听器（选在 `store/runs` 而非 `settleRun`：要覆盖全 provider、全终结路径）→ run 终结 → `conv-notify.js` `onRunSettled` 推私聊卡片（卡片失败降级纯文本，仅确实送达才记 `lastNotifiedAt`）。用户飞书回「补充内容」→ `injectToConv`：有运行中 run 时**一律进 busy inbox**（Claude → 持有缓冲；openai → follow-up 排队，终结后由 `conv-inbox` 排空起下一轮；同会话永不并发）；否则 `resume` 原 session 新起一轮 `startClaudeRun`。

### E. 需求工作流
HTTP `/api/req/*` → `routes-requirements.js`（单入口分发）/ `routes-req-v2.js` → `requirement-ops.js` 编排：`startRequirementPump` 单泵按串行闸出队（busy 空且该 conv 无活跃 run）→ 直调 `startClaudeRun` 或 `runClaude`；prompt 构造 / 解析等纯逻辑在 `req-*.logic.js`。busy 落盘镜像供崩溃恢复，`healStaleBusy` 兜底续跑链泄漏。系统任务 kind 现有 `docgen / quizgen / mapgen / mapfix / mapchange / mapregen / bug-fix / colleague-dev`；`colleague-dev` 落在**子会话**而非主会话，`busy.convId` 因此是双重契约 —— 前端接流（`req-chat.js#mountReqChrome`）与 `isBusyStale` / `recoverBusyOnBoot` 查待续跑登记都以它为准，拿主会话 convId 查会把续跑中的任务误判成泄漏、清 busy 击穿串行闸。

**会话按阶段隔离（dev→test）**：`sessions[]` 每条带 `phase`（诞生时的需求阶段），侧栏只渲当前阶段的会话，测试期从一根干净的新主会话开始。四个落点必须一起看，改一处就得对另外三处：
- `phaseGuard` 用 `req-logic.js` 的 `runningSessions(sessions, **r.phase**, hasActiveRunForConv)` 检查**当前阶段全部**会话（旧版只查主会话 `convId`，开发期子会话还在改代码也照样放行）。第二参传 `toPhase` 会让守卫真空通过——形参名就叫 `currentPhase` 以挡这个。
- `handleDevDone` 把 `normalizeSessions(r)` **物化后**再清 `convId`/`devSession`，且必须读**未更新**的 `r`（时序坑见 `store/CLAUDE.md`）。清锚点是「测试期开新主会话」的触发器。
- `handleConv` 是**唯一**创建 `kind:'main'` 的路径（四个前端调 `/api/req/session` 的点都不发 `main`）。它三分支：同 convId 已存在→不动；当前阶段已有 main→**重指**那行的 convId（换浏览器/桌面版/清站点数据会铸新 convId，新推就会堆出删不掉的重复 main）；否则才新建。POST 成功后由 `req-view.js` 的 `openRequirementChat` 就地 `refreshReqList()`——`applyFetchedReq` 不 await 它，交给上游刷会刷到流转瞬间的旧 sessions。
- `handleSession` 给新会话盖 `phase: r.phase`，main 唯一性收窄为**阶段内**唯一，`devSession` 回填加 `target.phase === r.phase` 判据（否则历史阶段 main 的迟到回填会污染当前锚点）。

归档期「优化汇总」`runRetroMapReduce` 仍遍历**全部**非 retro 会话（含开发期）——隐藏只在渲染层，数据一条不删。

### F. 项目体检 / 优化
HTTP `/api/optimize/*` → `routes-optimize.js` → `optimize-ops.js`：静态维度同步返回，`prompts`/`comments` 两个 LLM 维度后台并行跑、经 SSE（借 `store/runs` 的 `sendTo`）回填；带串行闸防同目录并发重复烧额度。

## 三、常见改动入口

- 要**加一个 HTTP 端点**，就改 `web/server.js` 的 ROUTES 表加一行 + 把 handler 放进对应 `web/routes-*.js`（注意顺序：精确路由必须排在能覆盖它的前缀之前，`findShadowedRoutes` 会在启动时喊出遮蔽）。
- 要**改 Claude 起跑 / 收尾 / 额度续跑 / 工具审批**，就改 `web/run-claude.js`；只是纯判定（是否重试/是否续跑）就改 `web/run-claude.logic.js`；改**启动对账归类**（孤儿 resume/abandon/discard）就改 `web/run-reconcile.logic.js`。
- 要**改子代理的句柄/通信语义**（状态机、命名与寻址、邮箱上限、等待夹取、文案），就改 `capabilities/agent-registry.logic.js`（纯函数 + 单测，journal 回放也用同一个 reducer）；句柄表/续轮/中断/收尾在 `capabilities/agent-registry.js`；接线（`runTurn` = 跑一轮子代理、四个工具的开关与派遣）在 `web/run-openai.js`——**别在编排层另写一份状态机**。
- 要**改 openai-compat 的凭证选择或工具审批**，就改 `web/run-openai.js`（工具本体与放行规则在 `providers/builtin-tools.js`；委托同事对话的工具面在 `capabilities/feishu-ask-tools.js`，引擎/截获在 `capabilities/feishu-ask.js` 与 `web/routes-requirements.js` 的 turn 与 feishu-ask 两端点；飞书卡回调在 `capabilities/feishu-ask-card.js`）。
- 要**改上下文压缩的触发/保留/摘要口径**（条数或 token 双触发、保留窗口 token 预算、四要素摘要、切点边界），就改 `web/conv-compact.logic.js` + `capabilities/context-budget.logic.js`（估算与 90% 阈值判定）；编排与 `compaction` journal 事件在 `web/run-openai.js#maybeCompactHistory`；每步用量 `usage` 事件在 `store/runs.js#runUsage`。要**改发送前消息序列的修复口径**（悬空合成文案、孤立清理、剪空、单条截断）→ `capabilities/context-normalize.logic.js`，接线在 `web/run-openai.js`（载入落盘 + 构建请求前终检）。要**改模型流重试/空闲超时口径**（可重试判定、退避与次数、空闲阈值、`MODEL_STREAM_*` env 旋钮）→ `providers/model-retry.logic.js`（决策）+ `providers/agent-loop.js#runModelStep`（执行）；用户可见提示与 `model_retry` journal 在 `web/run-openai.js` 的 `hooks.onRetry`。
- 要**让 Claude 路径也能委托同事对话**（工具注入/免审批），就改 `web/run-claude.js` 的 `mcpServers` 注入与策略门 `readOnlyExtra`（工具包装在 `capabilities/feishu-ask-sdk.js`）。
- 要**改 run 端点行为**（停止 / 插话 / 决策 / 切模式 / SSE 附加 / 用户埋点），就改 `web/routes-run.js`。
- 要**改工具审批策略**（放行/审批/拒绝、危险命令名单、安全命令表、无人值守档位）→ 改 `capabilities/tool-policy.logic.js`（规则表）+ `capabilities/tool-policy.js`（运行时门）；两条路径的接线在 `web/run-claude.js` / `web/run-openai.js`；无人值守档位配置 = `bot.execPolicy`（设置页机器人表单）。要**改 Bash 执行后端**（本地/容器、镜像、网络）→ `providers/exec-backends*.js` + `settings.exec`（设置页「Bash 执行后端（自定义模型）」段落，UI 在 `public/index.html` + `public/js/settings-panel.js`）。要**改后台命令会话**（长任务 start+poll、stdout/stdin、进程上限与回收、yield 语义）→ `providers/exec-sessions*.js`，装配/禁用展开/收尾在 `web/run-openai.js`。
- 要**改 auto 判档策略**，就改 `web/tier.js`；要改工具摘要 / 只读工具集 / dialog 解析，就改 `web/tool-summary.js`。
- 要**改 CORS 白名单**就改 `web/origin.js`；改请求体读取就改 `web/body.js`；改输入归一 / 权限模式白名单就改 `web/input.js`。
- 要**改飞书入站特例**（群聊 @ 策略 / 图片文件材料池 / 云文档拉取 / 卡片回调），就改 `feishu/index.js`；改本地调试链就改 `console/index.js`。
- 要**改会话飞书通知或补充内容注入**，就改 `web/conv-notify.js`（卡片文案 / 判定等纯逻辑在 `web/conv-notify.logic.js`）；改其 HTTP 路由就改 `web/routes-conv-notify.js`。
- 要**改需求工作流编排**（docgen / 串行闸 / 崩溃恢复 / busy 自愈），就改 `web/requirement-ops.js`；改需求 HTTP 路由就改 `web/routes-requirements.js` 或 `web/routes-req-v2.js`；改 prompt / 解析等纯逻辑就改对应 `web/req-*.logic.js`；改测试期 bitable 巡检就改 `web/req-inspect.js`；改避坑清单读写就改 `web/req-pitfalls.js`。
- 要**改体检 / 优化编排**就改 `web/optimize-ops.js`，改其 HTTP 接口就改 `web/routes-optimize.js`。
- 要**改设置 / token / 凭证 / MCP / 插件启停**就改 `web/routes-settings.js`；改上传 / 目录浏览 / 静态托管就改 `web/routes-files.js`；改日志 / 任务 / 历史 / 动作 / 脚本 / 启动初始化就改 `web/routes-ops.js`；改记忆库 HTTP 就改 `web/routes-memory.js`。
- 要**改同事消息接管 / agent 对话**：文本链路 → `plugins/colleague-agent/feature.js`（P4 起 `match` 全接：名册内同事在意图分类之前归 agent；非名册 match 返回假照旧走分类），附件链路 → `feishu/index.js` 的 image/file 分支直接调 `plugins/colleague-agent/relay.js#relayToAgent`（**两条链路共用同一份判定**，不得另写一份）；两者都跨进程 `POST /api/req/colleague-agent/turn` 触发 **web 进程**跑一轮 agent（`handleColleagueAgentTurn` → `plugins/colleague-agent/session.js`），限流闸也在 web 侧（`plugins/colleague-agent/rate-limit.js`）。回复由 web 进程跑完 agent 后经 lark 发往**来源会话**（2026-10-13 起：群里 @ 出来的回群里并 @ 提问人，私聊里的回私聊；路由判定 `shared/reply-target.js`，chatId/chatType 随 payload 透传），飞书侧不再回 ACK。**「正在处理」表情标记的摘除凭据（feishuMessageId/reactionId）随同一 payload 移交**，`handleColleagueAgentTurn` 在本轮结束（agent 回复 / 委托步进结束）后 `clearProcessingMark` 摘除（2026-10-14；语义见 shared/processing-mark.js）。web 侧读写端点在 `web/routes-requirements.js` 的 `/api/req/colleague-messages*`。改需求写工具的具体逻辑（`register_api_doc`/`start_dev_task`/`submit_req_change`/`supplement_requirement`/`upload_design_ref`）→ `plugins/colleague-agent/tools/req-write.js`；改 run_action/report_bug/tracking_report/notify_host 分别去对应插件的 `agent-tools.js`；改子会话执行侧（起 run / 清 busy / 回简报 / 写撤销台账）→ `web/colleague-dev.js`，其纯函数层在 `web/colleague-dev.logic.js`。**例外**：若该同事正被某次「委托提问」等待（`capabilities/feishu-ask.js`），其回复会在 turn 路由里被截获交给判定引擎，**不起**同事 agent。
- 要**改 agent 写操作的撤销**（六种 kind：revert-merge/delete-apidoc/revert-req-change/remove-supplement/discard-task/remove-figma）→ `web/undo-agent-action.js`；HTTP 入口是 `web/routes-requirements.js` 的 `POST /api/req/agent-action/undo`（**web 监管面板与飞书撤销卡片共用**；飞书侧回调在 `plugins/colleague-agent/card-action.js`，跨进程 POST 过来）；**队列撤退**（只动尚未出队的地图更新/文档修订）→ `web/requirement-ops.js#cancelQueuedTask` / `removeQueuedSupplement`；**台账写入器**在 `capabilities/agent-tools.js#recordLedger`（即时写 / `selfLedger` 跳过 / 失败不写 / undo null 降级），由 `server.js#loadPluginSideEffects` 的四个插件触发自注册。
- 要**改 web 监管面（同事面板）** → 前端 `public/js/colleague-supervisor.js`（顶栏 `#colleaguesBtn` + `data-view="colleagues"`：按人看对话/工具轨迹/台账撤销 + **主动发消息**——2026-10-15 需求页「开发人员」收成纯指派入口后，跟同事说话统一在这里）；数据按人端点在 `web/routes-requirements.js`：`GET /api/req/colleague-threads`、`GET /api/req/colleague-thread`、`GET /api/req/agent-actions`、`POST /api/req/colleague-thread/read`。
  - 发消息（2026-10-16 改版）：归属下拉的候选由 `colleague-threads` 的 `reqs`（带 `phase`）给出，**只列进行中的需求**（归档/废弃不能选，唯一候选默认选中，规则纯函数在 `public/js/req-phase.logic.js`，与侧栏需求列表同一份口径）；下拉与发送按钮都内嵌在输入框里，**本视图里只留这一个输入框**——底部 composer 由 `.app.in-colleagues .composer` 收起（它发的是对话消息，在这儿点了只会跳回聊天视图）。
- 要**改主机撤销卡片的推送/文案** → 推送侧 `web/colleague-dev.js#notifyHostUndo`（开关 `uiPrefs.taskNotifyFeishu`，与任务卡片同一个「主动打扰」开关；fire-and-forget）；卡片构造/解析纯函数在 `shared/agent-undo-card.js`（推送在 web、回调在 feishu，shared 是唯一共用层）。
- 要**改同事名册 HTTP 接口**就改 `web/routes-colleagues.js`；要改需求的开发人员指派就改 `web/routes-requirements.js` 的 `handleAssignees`（刻意独立于 `handleConfig`，理由见其注释）。
- 要**改 BUG 巡检循环**：HTTP 端点改 `web/routes-patrol.js`，泵与状态机改 `plugins/team-tools/bug-patrol/loop.js`（泵由 `server.js` 的 listen 回调启动，与 `startAutoDevPump` 同范式）。
- 要**改路由分发或启动自检逻辑**（而非某条具体路由），就改 `web/route-match.js`——它是唯一不依赖真实服务即可测试的分发层。
- 要**改顶栏的项目控件（工作目录 `#dirBtn` / 分支 `#gitBtn`）的显隐** → 只在 `public/app.css` 里改 `.app.sidebar-req` / `.app.in-req` 这两组选择器：需求有自己的工程目录，侧栏切到「需求」tab（`app.js#initSidebarSwitch` 在 `.app` 上打 `sidebar-req`）或主区打开需求页时，当前会话的项目摆在那儿是误导（2026-10-16）。
