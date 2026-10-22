# src/capabilities · 模块地图

**定位**：通用能力层——无业务语义、可被 `features`/`plugins` 复用的基础设施。按分层单向依赖，本层只向下依赖 `integrations`/`store`/`shared`，不 import 上层。核心能力包括：备用账号轮换（`token-rotation`）、**工具策略引擎**（`tool-policy`：规则表 + 运行时门，两条 provider 路径与无人值守共用，T6）、两种形态互补的 LLM 调用骨架（`llm-classify` 单轮零工具 / `llm-readonly-agent` 多轮只读），agent 工具注册表与对话骨架（`agent-tools` 工具注册 + 危险级校验 + 按角色装配 MCP server / `agent-session` 多轮带工具、跨消息续跑的对话循环，供 `plugins/colleague-agent` 这类持久对话 agent 使用），以及「委托同事对话」子引擎（`feishu-ask`：一次一问+选项 → LLM 判定/自动追问 → 得出结论交回主 agent；两条 provider 路径共用，飞书与 web 执行台双端同卡联动），以及**上下文预算纯函数**（`context-budget`：字节启发式 token 估算 + 窗口 90% 阈值判定，供压缩触发与保留窗口收缩，P0），以及**发送前上下文 normalize 纯函数**（`context-normalize`：消息序列不变量——就近配对 / 脱档前拉 / 孤立清理 / 剪空 / 单条中间截断，openai 路径发送前必过，P0-③），以及**子代理句柄注册表**（`agent-registry`：状态机 + 命名/寻址 + journal 归约 + 四个控制工具 send_message/wait_agent/interrupt_agent/list_agents；只读子代理从「一次调用用完全忘」变成有地址、有状态、可续轮的实体，P1-7）。

## 文件清单

| 文件 | 职责 |
|---|---|
| `token-rotation.js` | 备用 Token 轮换引擎：纯函数状态机（`pickActive`/`reduceRateLimit`/`recoverExpired`）+ 有状态胶水（读写 settings、switch-back 定时器、切换通知）。active token 不落库，由 `pickActive` 实时算出「偏好最高的可用号」。 |
| `token-rotation.test.js` | 纯函数状态机的单测。 |
| `llm-classify.js` | 单轮**零工具** LLM 分类骨架，各分类点共用；封装事故驱动的防卡死细节（额度 fail-fast、abort+race 双保险、禁全部工具、首个 JSON 块提取、失败归因），并统一 `DEFAULT_EFFORT='low'`（全部调用点都是浅层任务，逐点传会分叉）。 |
| `llm-classify.test.js` | `extractFirstJsonObject`/`classifyOutcome` 等的单测。 |
| `llm-readonly-agent.js` | 多轮**只读** LLM 骨架，用于必须实地读代码才能作答的任务（生成项目地图）；核心是三层只读防线。 |
| `agent-tools.js` | Agent 工具注册表：`registerAgentTool` 校验四档危险级（`safe`/`reversible`/`external`/`notify`，`reversible` 必须给 `buildUndo`、`external` 必须给 `exposedFlag`）→ `filterToolsByRole` 按角色过滤 → `buildAgentMcpServer` 组装成进程内 MCP server + **写撤销台账**（`recordLedger`：失败不写 / `selfLedger` 跳过 / `undo:null` 降级 / `__private` 锚点不进模型上下文）。插件在**模块加载时**注册工具（与卡片回调同一范式），本模块零业务语义。 |
| `agent-tools.test.js` / `agent-tools.ledger.test.js` | 注册校验、按角色过滤、MCP 装配 + 台账写入三态（成功/失败/降级）与 `__private` 的单测。 |
| `agent-session.js` | 对话型 LLM 骨架：`runAgentTurn` 跑一轮**带业务工具、跨消息续跑**的对话（靠 SDK `resume` 维持长期 thread，与另外两种骨架的一次性调用不同）。唯一消费者是 `plugins/colleague-agent`。 |
| `agent-session.test.js` | 注入假 `query`：工具调用、拒绝、超时、解析失败四条路径的单测。 |
| `verifier.js` | 验证器：跑**一条 owner 配置的**验证命令并归一结果（通过/失败/超时/跳过）。命令来源：显式配置 > 自动发现（`package.json` 有真实 test 脚本 → `npm test`，`resolveVerifyCommand`）> 空串按「未配置」跳过。fail-open 边界：未配置、命令不可用（`where`/`command -v` 探测）算跳过；正常执行的非零退出/超时才算失败。硬约束：命令只来自人配置或工程 test 脚本，任何运行时数据不得拼入。 |
| `verifier.logic.js` | 验证器纯函数：输出头尾截断、时长/摘要格式化、任务字段归一（输出与记录分离）、自动发现判定（`discoverVerifyCommand`，剔除 npm init 占位脚本）。 |
| `verifier.test.js` / `verifier.logic.test.js` | 真 shell（tmp 工作区）与纯函数单测。 |
| `tool-policy.logic.js` | **工具策略规则表**（T6）：`classifyTool`（read/write/execute/**session**/network/agent/other；`session` 类=P1-6 命令会话控制——`write_stdin`/`kill_process`/`list_processes` 只操作本 run 经审批自建的进程，除 plan 外放行，`write_stdin` 的 `chars` 命中危险名单降级 ask；`exec_command` 并入 execute 类与 Bash 同径）、六档矩阵（四档 mode + 无人值守 standard/trusted）、危险命令 deny 名单（`detectDangerousCommand`，独立于档位、宁漏勿误杀；含删根/毁盘/关机/炸弹/全盘改权限/**进程击杀类 taskkill/pkill/killall/Stop-Process/kill -N**，A8）、安全命令表（`isSafeCommand`，只认单段命令）、`resolveUnattendedPolicy`（`bot.execPolicy` → 档位 + SDK mode）。零 IO；路径判定复用 `shared/workspace-paths`。 |
| `tool-policy.js` | 策略运行时门：`createPolicyGate`（无人值守 ask→deny 翻译 + 策略拦截计次、`onFuse` 恰一次；交互路径只 deny 不熔断）、`PRETOOL_ASK_HOOK`、`buildClaudePretoolHook`（**动态档位 PreToolUse 钩子**，2026-10-11 补强：default 恒 ask 交回 canUseTool；bypass 档 = deny 名单守卫——SDK 在 bypass 不调 canUseTool，危险命令由此兜底；acceptEdits/plan 不表态；档位调用时读取，覆盖中途切档）、`buildUnattendedClaudeOpts`（直调 `runClaude` 的无人值守选项拼装；bypass 档挂守卫钩子，审批面与改动前一致、deny 不再真空）。**不 import store/runs**：停 run 与通知由调用方在回调里做。 |
| `tool-policy*.test.js` | 规则表表驱动（6 档×类别×区内/外）；危险命令正/反例；安全命令边界（链式/重定向不放行）；门的行为（翻译/计次/熔断/别名/回调容错）。 |
| `feishu-ask.js` | 「委托同事对话」核心：内存委托注册表 + 发起（发卡片/留痕/**推 web 提示卡**）+ 同事回复截获（`handleColleagueAskReply`）+ **点选截获**（`handleColleagueAskOption`）+ **主机拍板**（`confirmAskFromHost`，立即结算并通知同事）+ 判定步进（追问/结算，结算时收起 web 卡）+ `waitForReply`（打心跳防看门狗）。 |
| `feishu-ask.logic.js` | 委托对话的纯函数：职位目标解析、询问卡（**带选项按钮**）、判定 prompt（**带可选答案**）、判定结果解析、转录格式化。 |
| `feishu-ask-tools.js` | 工具面：`AskColleague`（走审批，**options 必填 2~4 个**）/ `WaitColleagueReply`（免审批）两个模型工具；schema 是 zod object（openai 路径整对象校验）。装配两条路径：`run-openai.js` 直装、`run-claude.js` 经 `feishu-ask-sdk.js` 转 MCP。 |
| `feishu-ask-sdk.js` | 上者的 **Claude Agent SDK 版**：`buildFeishuAskMcpServer` 取 zod object 的 `.shape` 包成进程内 MCP server（名 `feishu-ask`）；`FEISHU_ASK_SDK_READONLY` 给策略门免审批（**全名** `mcp__feishu-ask__WaitColleagueReply`）；`FEISHU_ASK_SDK_ALIASES`（全名→逻辑名，从 `FEISHU_ASK_TOOL_NAMES` 派生）接进策略门 `alias`，让右下角工具列表的「问同事/等同事回复」开关在 Claude 路径同样生效。 |
| `feishu-ask-card.js` | 飞书「问同事」卡的选项按钮回调（`kind='feishu-ask-answer'`）：解析按钮 value → 跨进程 POST 回 web 的 `/api/req/feishu-ask/answer`。**只被飞书入口 import**（side-effect 注册）。 |
| `web-tools.logic.js` | **联网工具纯函数**（A7）：`normalizeFetchUrl`（仅 http/https）、`htmlToText`/`decodeEntities`/`clipText`（HTML→可读文本）、`buildSearchRequest`/`parseSearchResults`/`formatSearchResults`（tavily/brave/bocha 三家的请求构造与响应解析，`SEARCH_PROVIDERS` 白名单）。零 IO。 |
| `web-tools.js` | 联网工具运行时（A7）：`createWebTools({search, fetchImpl})` → `WebFetch`（15s 超时/1MB 流式上限/HTML→文本）+ `WebSearch`（未配 key 返回指引文案；401 提示检查 key）。审批走策略表网络类（`NET_TOOLS`）。 |
| `subagent.logic.js` | **只读子代理纯函数**（A7）：`READONLY_SUBAGENT_TOOL_NAMES`（Read/Glob/Grep/WebFetch/WebSearch/RepoMap）、`pickReadonlyToolDefs`（**不含 Task → 天然禁递归**）、`buildSubagentSystemPrompt`、`SUBAGENT_TOOL_DEF`。装配/嵌套执行在 `entrypoints/web/run-openai.js`。 |
| `workflow.logic.js` | **自定义模型的 Ultracode 编排纯逻辑**（A11）：`normalizeWorkflowSpec`（阶段/子任务归一 + 四处上限截断：4 阶段/每阶段 6/合计 12/prompt 4000 字）、`runWorkflowPlan`（逐阶段推进 + 阶段内并发池，注入式 `runTask`，失败不中断、abort 即停）、`mergeWorkflowResults`（汇总回主模型，单条 2k/总量 12k 截断）、`WORKFLOW_TOOL_DEF`（zod schema）、`buildUltracodeAuthPrompt`（授权说明）。零 IO：真装配（只读子代理嵌套）在 `entrypoints/web/run-openai.js`。 |
| `workflow.logic.test.js` | 归一边界/截断记账、并发池顺序与峰值、失败与中断、汇总裁剪、工具 schema 正反例。 |
| `agent-registry.logic.js` | **子代理句柄纯函数**（P1-7，Codex `AgentHandle` 对位）：状态机（`AGENT_STATUSES`/`isTerminal`/`canTransition`，终态不可复活）、命名与寻址（`nextAgentId`/`buildAgentName` → `/root/<slug>-<n>`、`selectAgent` 按 id 或名字）、journal 归约（`applyAgentEvent`/`reduceAgentEvents`，**运行时与回放同源**）、文案（派发/发送/等待/中断/未知/容量 + `renderAgentList`/`formatAgentLine`）、等待夹取（`clampWaitMs` 默认 30s / 1s–300s）、四个工具 schema（`send_message`/`wait_agent`/`interrupt_agent`/`list_agents`）。零 IO。 |
| `agent-registry.js` | **子代理句柄运行时**（P1-7，per-run，注入式）：`spawnBlocking`（Task/Workflow 的阻塞语义）/`spawnBackground`（`Task({background:true})`）、`send`（空闲起新一轮 / 运行中入邮箱当前轮结束自动接续）、`wait`（巡检 + 心跳，超时如实返回）、`interrupt`/`interruptAll`、`settleAll`（run 收尾等 60s 后 abort）、`executeTool`+`toolDefs`。续轮接续由本模块负责（`runTurn` 收 `/root` 之外的完整 messages、返回不含 system 的 history）；状态显示字段由 `.logic.js` 的 reducer 推进，句柄只存运行期私货（历史/邮箱/AbortController）。**不认识 LLM**：跑一轮靠注入的 `runTurn`（装配在 `entrypoints/web/run-openai.js#callAgentTurn`）。 |
| `agent-registry.logic.test.js` / `agent-registry.test.js` | 纯函数侧：迁移合法性（含终态不可复活）、命名/寻址、归约可复现、文案、夹取、schema。运行时侧（注入假 `runTurn`）：阻塞/后台派发、邮箱与自动接续、wait 超时与心跳、中断与迟到收尾、并发闸、settleAll/interruptAll、未知 id 文案、emit 抛错不拖垮 run。 |
| `context-budget.logic.js` | **上下文预算纯函数**（P0，对标 Codex）：`estimateTextTokens`（UTF-8 字节 ÷ 4 向上取整）、`estimatePartTokens`（text/reasoning/image/tool-call/tool-result；图片固定估值、未知类型不猜）、`estimateMessagesTokens`、`contextTokenStatus`（唯一阈值判定点：窗口未知只报 tokens、绝不判过线；`AUTO_COMPACT_RATIO=0.9`）。消费方：`entrypoints/web/conv-compact.logic.js`（保留窗口 token 感知）与 `run-openai.js`（压缩双触发）。零 IO。 |
| `context-budget.logic.test.js` | 估算口径（多字节/各 part/序列化失败）与 90% 阈值边界的正反例。 |
| `context-normalize.logic.js` | **发送前上下文 normalize 纯函数**（P0-③，对标 Codex `ContextManager::for_prompt`）：`normalizeSequence`（tool-call 就近配对；结果脱档则前拉到调用后；孤立/重复 tool-result 剔除；悬空合成「未执行」）、`pruneEmptyMessages`（只剪空 assistant/tool）、`trimLargeParts`（单条超长中间截断，默认 120k 字符/part）、`clipMiddle`（60/40 保头尾，从 conv-compact 迁入统一）、`normalizeForModel`（唯一组合点，干净序列原引用返回）。消费方：`entrypoints/web/run-openai.js`（载入历史时合成落盘 + 构建请求前幂等终检）。零 IO。 |
| `context-normalize.logic.test.js` | 配对/孤立/前拉（含不重复、幂等）/剪空/截断（各 part 形态与旋钮）/组合入口的正反例（25 用例）。 |
| `feishu-ask*.test.js` | 三件套单测：纯函数 / 注册表与引擎（注入桩件，不触网络）/ 工具文案。 |
| `builtin-mcp.js` | 内置 MCP 注册表（context7 / Figma 双形态）：按开关+目标路径解析、npx 平台形态、密钥只进 env、SDK 形态映射、本地服务探测。命令是代码常量，不接受运行时数据。 |
| `builtin-skills.js` | 内置 Skills 注册表（Superpowers）：白名单（与 fetch 脚本共用）、安装判定（plugin.json + skills 同在）、清单解析（`listItems` 附 per-skill 项）、`resolveSkillPlugins`（启用且已安装才产出 SDK 本地插件条目；存在停用项时先物化「启用视图」镜像——`materializeSkillPlugin`，打包态镜像落 APP_DATA_DIR）。 |
| `builtin-mcp.test.js` / `builtin-skills.test.js` | 注册表一致性（与 `shared/builtin-ids` 严格对齐）、开关/路径/密钥/平台、安装判定与插件解析。 |

## 关键流程

### 模块内的分层关系（读代码才看得出）

`token-rotation.js` 是本模块地基：另外两个骨架都 import 它的 `claudeAuthOpts`/`getTokens`/`isPoolExhausted`，而它反过来不依赖任何一个。两个 LLM 骨架是**并列**的两种调用形态（文件头明确写了分工），但并非全无关系——`llm-readonly-agent.js` 复用了 `llm-classify.js` 导出的 `extractFirstJsonObject`（JSON 抽取逻辑只此一份，不重复造）。所以模块内依赖方向是：

```
llm-readonly-agent ──┬─→ llm-classify(extractFirstJsonObject)
                     └─→ token-rotation ──→ store/settings, shared/provider-ids
llm-classify ────────────→ token-rotation
(三者)      ────────────→ integrations/claude.js(runClaude)
```

### 流程一：Token 轮换（谁在跑、撞墙后怎么切、怎么切回）

1. **起跑注入**：调用方 `runClaude(prompt, { ...claudeAuthOpts(), ... })`。`claudeAuthOpts()` → `getActiveToken()` → `pickActive(getTokens())` 算出当前该用哪个号，注入 env `CLAUDE_CODE_OAUTH_TOKEN` + 挂 `onRateLimit` 归因回调；无可用备用号则返回 `{}`（退回主账号登录）。
2. **撞墙**：SDK 报限流 → `noteRateLimit(tokenId, info)` → `mutateTokens((cur) => reduceRateLimit(...))` 在文件锁内读-改-写 settings（web/feishu 双进程都会写，不锁会互相覆盖）→ 纯函数 `reduceRateLimit` 推进该号状态机（healthy/warning/exhausted）并算出 switch 通知。
3. **排程切回**：`noteRateLimit` 末尾调 `scheduleAllSwitchBacks()`，为非 healthy 且有 `resetsAt` 的号设定时器（到点 +30s）；触发 `doRecover()` → `recoverExpired()` 把已到重置时刻的号恢复 healthy。因 active 由 `pickActive` 实时计算，主号一恢复 healthy 就自然重新成为 active——「切回原账号」是涌现出来的，无需显式记录。
4. **两种接入姿势**：绝大多数调用方走 `claudeAuthOpts()` 一把梭（见下方消费者列表）；唯有 web 主执行链 `entrypoints/web/run-claude.js` 因为要按 `run._tokenId` 逐 run 归因，手动拆用 `getActiveToken`/`noteRateLimit`。
5. **前端面板**：`entrypoints/web/routes-settings.js` 消费 `getStatus`/`consumeNotice`/`scheduleAllSwitchBacks`；`entrypoints/web/server.js` 启动时调一次 `scheduleAllSwitchBacks()` 恢复跨重启排程。

### 流程二：单轮分类（`llm-classify`）

`runClassifierOnce(opts)` 是 `runClassifierDetailed(opts).data` 的薄包装（多数调用点只关心「拿到没拿到」，只有 tracking-stats 需要失败原因才直接用 Detailed）。Detailed 的路径：`isPoolExhausted(getTokens())` 额度耗尽 fail-fast → `runClaude(..., maxTurns:1, disallowedTools:['*'])`（通配符禁全部工具，防分类模型把消息当真任务起子代理）→ `abort` 定时器 + `Promise.race` 双保险（限流时 SDK 流可能永不结束）→ 收集 `onText` → `classifyOutcome({aborted, text})`：**先** `extractFirstJsonObject`+`JSON.parse` 试解析、**再**看是否 aborted 判超时（模型常早早吐完 JSON 而流迟迟不收尾）→ 归结 `{data, reason:'exhausted'|'aborted'|'timeout'|'unparsable'|null}`。其中 `aborted` 是**外部中止**（调用方传了 `signal` 且已触发），它排在「先尝试解析」之前，且必须与 `timeout` 分开——超时值得重试，用户中止绝不该重试（否则点中止反而多烧一轮额度）。

### 流程三：只读多轮（`llm-readonly-agent`）

`runReadonlyAgent(...)` 同样先 `isPoolExhausted` fail-fast + 检查外部 `signal`。关键是**三层只读防线**（缺一即漏，均为事故换来）：第 1 层 `FORCE_ASK_HOOKS`（PreToolUse→'ask'，从 settings.json 的 allow 规则手里夺回裁决权）；第 2 层 `canUseTool` 运行时白名单 `READONLY_TOOLS`（无论工具被怎么捞回来，执行前都过这关，越权者记入 `denied`）；第 3 层 `disallowedTools: DENIED_TOOLS`（补不全，只为省轮次）。`permissionMode` 必须 `'default'`（`bypassPermissions` 会绕过前两层）。产出经 `extractFirstJsonObject` 抽 JSON，返回 `{data, reason, denied}`。唯一消费者是 `features/project-optimize/gen-map.js`（地图生成，超时 `READONLY_AGENT_TIMEOUT_MS`=600s，文件内注明并发压到 3）。

### 流程四：Agent 工具装配与对话轮（`agent-tools` + `agent-session`）

`registerAgentTool(def)`（各插件在**模块加载时**调用，与卡片回调 `registerCardKindHandler` 同一范式）→ `validateToolDef` 在注册期校验四档危险级的不变式（`reversible` 必须给 `buildUndo`、`external` 必须给 `exposedFlag`，缺了直接抛，不留到运行时才发现）→ 写入模块级 `registry`。

调用方（如 `colleague-agent/session.js`）按角色取工具：`buildAgentMcpServer(role, {ctx})` → `filterToolsByRole` 按 `roles` 过滤（**fail-closed**：未知/空角色只看得到 `'*'` 工具，绝不外推）→ 逐个包成 SDK `tool()` 定义、`createSdkMcpServer` 组装成进程内 MCP server，同时算出 `allowed` 全名白名单（`mcp__colleague__<name>`）。

**撤销台账（P4，`recordLedger`）**：handler 成功（非 `{error}`/`ok:false`）后，`reversible`/`external` 工具的每次调用由 wrapper 统一写 `store/agent-actions.js` 台账（`safe`/`notify` 不写、失败不写、`selfLedger:true` 跳过 —— 后者的锚点在收尾时由执行端写，如 `start_dev_task` 的 mergeSha）。`undo` 来自 `buildUndo(input, result, ctx)`；运行时给不出锚点 = 降级为 `undo:null` + error 日志（不静默）。handler 可返回 `__private` 字段：给 `buildUndo` 读（taskId/supplementId/figmaId 这类当场生成的锚点），wrapper 在 `textResult` 前剥掉 —— **模型上下文里不存在**。

`agent-session.js#runAgentTurn` 拿到 `{server, allowed}` 后组装 `query()` 的 options，三条缺一不可、少一条「危险级判定」就静默失效：**`tools:[]`** 禁掉全部内置工具（不能用 `disallowedTools:['*']`——那会连 MCP 工具一起删）+ `mcpServers` 挂上 server + `canUseTool` 复核每次调用是否在 `allowed` 白名单里（**不能**设 `allowedTools`——那会让 `canUseTool` 整个不被调用）+ `permissionMode:'default'`（`bypassPermissions` 会绕过 `canUseTool`）。

`agent-session.js` 与另外两个骨架（`llm-classify`/`llm-readonly-agent`）的分工差别只有一点：**`resume`**。另外两个都是一次性调用（`persistSession:false`）；本骨架靠 SDK 的 `resume: sessionId` 维持「这个人上次跟我聊了什么」的长期 thread，调用方自己存取 session id（`colleague-agent` 存在 `store/colleague-messages.js` 的 `agentSessionId` 字段里）作为锚点。

### 流程五：委托同事对话（`feishu-ask`，两条 provider 路径都能用）

主 agent 遇到「只有同事知道」的问题时调 `AskColleague`（**一次只问一个问题，并给 2~4 个选项**）：按 role/name 在同事名册定位唯一目标 → `genQuestionId` 后发飞书询问卡（问题 + 选项按钮）→ 内存注册表登记委托（同一同事仅一条进行中）→ **推一张非阻塞提示卡到 web 执行台**（`store/runs` 的 `presentNotice`，run 不在则静默跳过）→ 立即返回 questionId（非阻塞，主 agent 继续干别的）。

同事回复走飞书进程 relay → web 的 `/api/req/colleague-agent/turn`，`handleColleagueAskReply` 在**同事对话 agent 之前**截获（插件停用也照截，该闭环不依赖 colleague-agent）。同事**点选项**则走另一条入口：飞书卡回调（`feishu-ask-card.js` 注册的 kind）→ `/api/req/feishu-ask/answer` → `handleColleagueAskOption`（按 questionId 直查，转录记「（点选）X」）。两条入口汇入同一 **判定引擎**（复用 `llm-classify` 单轮 JSON 骨架，模型 `config.feishuAsk.model`）看「原问题 + 可选答案 + 对话记录」决定 done 还是 followUp —— 未结论则自动代发追问（上限 `MAX_FOLLOW_UPS`），达上限结算 `abandoned`（如实交回已有信息），有结论则结算 `concluded`（**并收起 web 同卡**）。

**主机在 web 执行台点选项**（同一张提示卡）走第三条入口：`POST /api/req/feishu-ask/confirm` → `confirmAskFromHost`。语义与同事点选**刻意不同**：同事点选只是「一次回答」（仍走判定确认细节），主机点选是**拍板**——直接 `settle('concluded')`（结论＝「开发者已确认：X」）、给同事发同文案、收起 web 卡。避免主机已确认而子引擎还在追问同事。

主 agent 用 `WaitColleagueReply` 拿结论（等待期间打心跳，避免被看门狗当静默卡死）；**等待超时 / 运行中断 = 取消整个委托**（不再自动追问打扰同事），迟到回复从注册表脱落、回落同事对话 agent。注册表在内存：委托绑定在 run 生命周期上，落盘只会制造无人认领的追问。

**两条 provider 路径**：openai-compat 在 `run-openai.js` 直装工具；Claude Agent 在 `run-claude.js` 经 `feishu-ask-sdk.js` 转为进程内 MCP server（`mcpServers['feishu-ask']`）。工具全名不同（`AskColleague` vs `mcp__feishu-ask__AskColleague`），故策略门「等待免审批」的 `readOnlyExtra` 用**全名**（`FEISHU_ASK_SDK_READONLY`）——写短名会静默变成「每次都弹审批」。

### 消费者速览

- **分类骨架**：`app/intent.js`、`plugins/team-tools/task-triage`、`plugins/team-tools/bug-patrol`、`plugins/action-runner/feature/slot-filler`、`plugins/tracking-stats/understand.js`（用 Detailed）、`features/project-checkup`、`features/memory-bank/extract.js`、`features/project-optimize/describe-skill.js`、`entrypoints/web/req-inspect.js`。
- **只读骨架**：`features/project-optimize/gen-map.js`。
- **`claudeAuthOpts` 直接接入**：`entrypoints/web/tier.js`、`entrypoints/web/requirement-ops.js`、`plugins/team-tools/*`（task-ops/review/project-qa）等。
- **agent 工具注册表 / 对话骨架**：唯一消费者是 `plugins/colleague-agent`（`index.js` 注册工具，`session.js` 调 `buildAgentMcpServer` + `runAgentTurn`）。
- **委托同事对话**：装配在**两条路径**——`entrypoints/web/run-openai.js`（直装 `feishu-ask-tools`）与 `entrypoints/web/run-claude.js`（经 `feishu-ask-sdk.js` 转 MCP）；同事回复截获在 `entrypoints/web/routes-requirements.js` 的 turn 路由，点选/主机确认在该文件的 `/api/req/feishu-ask/answer`、`/api/req/feishu-ask/confirm` 两端点；web 同卡走 `store/runs` 的 notice 通道（`presentNotice`/`dismissNotice`）；判定引擎复用 `llm-classify`。
- **验证器**：`plugins/team-tools/auto-dev/verify.js`（自动开发自检门，Phase 1；Phase 2 起未配置时自动发现 `npm test`，设置页可配、任务面板展示结果）。
- **内置能力**：`capabilities/builtin-mcp.js`（openai 路径偏 `run-openai.js` 合并；Claude 路径偏 `run-claude.js` 转 SDK 形态）与 `capabilities/builtin-skills.js`（`run-claude.js` 注入插件——含 per-skill 停用时的启用视图镜像；`routes-settings.js` 的 `/api/builtins` 出清单与 per-skill 开关；chat 工具弹层同源渲染）。

## 常见改动入口

- 要**加/改一个新号的选取偏好或撞墙后的状态迁移**，就改 `token-rotation.js` 的纯函数 `pickActive` / `reduceRateLimit` / `recoverExpired`（先在 `token-rotation.test.js` 补例）。
- 要**调切回原账号的时机/定时器行为**，就改 `token-rotation.js` 的 `scheduleAllSwitchBacks` / `doRecover`。
- 要**让某个新的 `runClaude` 调用点也跟随备用账号轮换**，就在该调用点 spread `claudeAuthOpts()`（不要动本模块）；只有需要逐 run 归因时才仿照 `run-claude.js` 手动拆 `getActiveToken`/`noteRateLimit`。
- 要**改前端 token 面板展示字段/通知**，就改 `token-rotation.js` 的 `getStatus` / `consumeNotice`（消费方在 `routes-settings.js`）。
- 要**加一个新的单轮分类点或调分类的超时/防卡死策略**，就改 `llm-classify.js`（分类点各自传 `prompt`/`model`/`logTag`/`timeoutMs`，语义校验留在各自调用方）。
- 要**改「模型回复里抽 JSON」的规则**，只改 `llm-classify.js` 的 `extractFirstJsonObject`（只读骨架也复用它，改一处两处生效）。
- 要**改自定义模型 Ultracode 的编排语义**（阶段/子任务上限、并发度、汇总裁剪、工具描述、授权说明文案），就改 `workflow.logic.js`（纯逻辑 + 单测）；只读子代理执行体在 `entrypoints/web/run-openai.js#callAgentTurn`（Task 与 Workflow、以及 send_message 的续轮共用一处，别分叉）；授权位由 `routes-run.js` 透传到 `startOpenAiRun`。
- 要**改子代理的句柄/通信语义**（状态机与合法迁移、id/名字与寻址、邮箱上限、并发闸、等待夹取、工具文案），就改 `agent-registry.logic.js`（纯函数 + 单测）；运行时（续轮、邮箱消费、中断、收尾）在 `agent-registry.js`；`runTurn` 注入与四个工具的开关注册在 `entrypoints/web/run-openai.js`。**状态机只此一份**：journal 回放（`store/run-replay.logic.js` 的 `agents` 车道）与内存状态都由 `applyAgentEvent` 推进。
- 要**放宽/收紧只读调用允许的工具**，就改 `llm-readonly-agent.js` 的 `READONLY_TOOLS` 白名单（第 2 层是真正的闸）；`DENIED_TOOLS` 只是减少无用尝试，别指望它兜底。
- 要**调上下文预算口径**（字节系数、图片估值、90% 阈值、消息参与估算的范围），就改 `context-budget.logic.js`（纯函数 + 单测）；压缩触发组合/保留策略/摘要 prompt 在 `entrypoints/web/conv-compact.logic.js`，编排在 `run-openai.js#maybeCompactHistory`——别在编排层重算百分比。
- 要**改发送前消息序列的修复口径**（悬空合成文案、孤立清理、剪空、单条截断上限与省略标记），就改 `context-normalize.logic.js`（纯函数 + 单测）；接线（载入时合成落盘、构建请求前终检）在 `entrypoints/web/run-openai.js`——别在编排层另写修复分支。
- 要**新增一种「读代码作答」的多轮只读任务**，复用 `runReadonlyAgent`（传 `cwd`/`prompt`/`signal`），把业务逻辑放到 `features`/`plugins`——本模块只提供无业务语义的骨架。
- 要**加一个新的 agent 工具**，在自己插件的模块加载处调 `registerAgentTool`（参照 `plugins/colleague-agent/index.js`），**不要改 `agent-tools.js`**——本模块只提供注册表与危险级校验，不认识任何具体业务工具。三条固定检查项（模型上下文不许出现主机内部信息 / 撤销锚点走 `buildUndo` + `__private` / 失败返回 `{error}`）见 `agent-tools.js` 文件头。
- 要**让新工具在 web 进程可用**（工具只在 web 被调用），把插件 id 加进 `entrypoints/web/server.js#loadPluginSideEffects` 的清单；漏加 = 零工具 MCP server、模型凭记忆作答且全链路无声。`reversible` 工具的撤销执行侧在 `entrypoints/web/undo-agent-action.js`（新 kind 要同时扩 `store/agent-actions.js#UNDO_KINDS`）。
- 要**放宽/收紧某档危险级的注册期校验**，就改 `agent-tools.js#validateToolDef`（四档不变式都收在这一个函数里；改之前想清楚是不是在加一条新的硬约束，而不是给已有的开口子）。
- 要**改一轮 agent 对话的超时/取消语义**，就改 `agent-session.js` 的 `AGENT_TURN_TIMEOUT_MS` 与 `runAgentTurn` 里的 `AbortController`/`signal` 逻辑；组装 `query()` options 那部分单独抽成了纯函数 `buildTurnOptions`，改文件头那两个「用错就静默失效」的坑时看这里。
- 要**让某个分类调用点支持中止**，就在该调用点传 `signal`（`llm-classify` 已支持，不传即行为不变）；目前只有体检链路的三处传了（`audit-engine` / `check-prompts` / `check-comments`）。
- 要**改委托同事对话的行为**（追问上限/TTL/判定 prompt/目标解析/选项归一），就改 `feishu-ask.logic.js`（纯函数）与 `feishu-ask.js`（注册表/引擎/点选/主机确认/notice 接线）；工具文案与 options schema 在 `feishu-ask-tools.js`，装配/审批在 `run-openai.js`（直装）与 `run-claude.js` + `feishu-ask-sdk.js`（MCP），路由截获/新端点在 `routes-requirements.js`，飞书卡片回调在 `feishu-ask-card.js`（`feishu/index.js` 副作用 import），web 提示卡通道在 `store/runs.js`（`presentNotice`/`dismissNotice`）。
- 要**改验证命令的执行/判定语义**（超时、fail-open 边界、命令探测、输出截断/摘要），就改 `verifier.js` / `verifier.logic.js`；**自动发现规则**（何时把工程默认成 `npm test`、如何识别占位脚本）在 `verifier.logic.js#discoverVerifyCommand` + `verifier.js#resolveVerifyCommand`。
- 要**改内置 MCP/Skills**（新增内置项、默认值、平台命令、白名单技能、安装判定），就改 `builtin-mcp.js` / `builtin-skills.js`（id 白名单同步 `shared/builtin-ids.js`，per-skill 项白名单=`SUPERPOWERS_SKILL_IDS`）；拉取逻辑在 `scripts/superpowers-fetch.mjs`；设置页 UI 在 `public/js/settings-panel.js`（「内置能力」区，per-skill 明细可折叠）；chat 工具弹层在 `public/js/chat.js#refreshToolsSection`。
- 要**改 per-skill 开关的存储/接口/物化语义**，依次看：`shared/builtin-ids.js`（白名单）→ `store/settings.js`（`normalizeBuiltinState` 的 `disabledSkills` 过滤 + `setBuiltinSkillItem`）→ `routes-settings.js`（PUT 的 `skillId` 分支）→ `builtin-skills.js`（`materializeSkillPlugin` 镜像与戳）。改的是「停用哪些」而不是「启用哪些」：新增技能默认启用。
