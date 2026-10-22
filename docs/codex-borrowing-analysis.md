# Codex 源码架构分析与本项目借鉴报告

> **分析对象**
> - Codex（openai/codex，Rust 实现）浅克隆，commit `806d973`（2026-10），路径 `codex-rs/`
> - 本项目（claude-p-web-demo）：Node.js + Claude Agent SDK / OpenAI 兼容自研循环的双路径 Web + 飞书服务
>
> **方法**：静态通读源码（未编译运行），双方向按 12 个维度盘点后对比。Codex 行号基于上述 commit；本项目行号基于当前工作区。
>
> **一句话结论**：本项目在「运行干预、持久化恢复、测试量」上并不弱，真正的短板集中在 **长任务架构（无 token 预算、压缩粗糙、重试缺失）、上下文管理（按条数而非按 token、无发送前规范化）、多 agent 协作（无统一抽象、无 mailbox、无状态机）** 三处；Codex 恰好在这三处有可以直接照搬的成熟设计。

---

## 目录

1. [总览对比表](#1-总览对比表)
2. [Agent 循环](#2-agent-循环)
3. [长任务架构 ★](#3-长任务架构-)
4. [上下文管理 ★](#4-上下文管理-)
5. [多 Agent 协作 ★](#5-多-agent-协作-)
6. [项目规则](#6-项目规则)
7. [权限沙箱](#7-权限沙箱)
8. [长命令管理](#8-长命令管理)
9. [工具按需加载](#9-工具按需加载)
10. [Code Mode](#10-code-mode)
11. [运行干预](#11-运行干预)
12. [持久化与恢复](#12-持久化与恢复)
13. [测试与可观测性](#13-测试与可观测性)
14. [落地路线图](#14-落地路线图)

---

## 1. 总览对比表

| # | 维度 | Codex 关键机制 | 本项目现状 | 差距 | 优先借鉴 |
|---|------|----------------|-----------|------|---------|
| 1 | Agent 循环 | Op/Event actor + 单活跃任务 + 分层循环（任务→turn→流重试） | openai 自研 `runAgentLoop`（较完整）+ Claude 用 SDK | 小 | 分层循环、工具并行、模型重试 |
| 2 | **长任务架构** | Pre/Mid/Post 压缩阶段 + 中心化 token 阈值 + 显式重试策略 + 计划外化 | 看门狗 + 检查点 + 崩溃对账；无 token 预算、无阶段化压缩、循环不重试 | **大** | P0：预算中心 + 压缩升级 |
| 3 | **上下文管理** | 单一 ContextManager + 发送前 normalize + bytes/4 预算 + world-state 差分 | 按条数滚动摘要；token 只上报不控制；无发送前规范化 | **大** | P0：规范化 + 预算体系 |
| 4 | **多 Agent 协作** | 同进程线程子 agent + mailbox + 状态机 + 角色降权 + 层级命名 | 只读子代理/Workflow/同事 agent 已有，但无统一抽象、无通信、无状态 | **中** | P1：AgentHandle + send/wait |
| 5 | 项目规则 | AGENTS.md 多层合并 + override + 32KiB 截断 + 信任级缓存 | CLAUDE.md（@ 引用）+ memory-bank + repo-map | 中 | 规则合并器 + 钩子事件 |
| 6 | 权限沙箱 | 审批/沙箱双枚举 + Starlark 前缀规则 + 平台沙箱 + 网络代理 | 策略矩阵 + deny 名单 + 容器 Bash（仅 openai） | 中 | Claude 路径补策略、审批记忆 |
| 7 | 长命令管理 | exec_command 会话化 + yield 时间片 + write_stdin + 头尾缓冲 | 仅超时强杀，无后台/持久 shell | **大** | 会话化命令管理器 |
| 8 | 工具按需加载 | exposure 分级 + tool_search(BM25) + MCP 延迟加载 | run 启动时一次性装配 | 中 | 工具注册表 + 条件装配 |
| 9 | Code Mode | V8 执行 JS，`tools.*` 调用工具 | 无（Workflow 是最接近的编排） | — | 暂不跟进，只借 tool_search 思路 |
| 10 | 运行干预 | steer 抢占流 + 两阶段中断 + pending 等待者统一清空 | steer 持有/撤回/立即打断 + follow-up 队列 + 看门狗 | 小 | 抢占当前流、steer 白名单 |
| 11 | 持久化与恢复 | rollout JSONL 唯一事实源 + 写恢复 + fork + daemon 对账 | journal + run-index + pending + 对账闭环 | 中 | 事实源统一 + fork + 工具幂等 |
| 12 | 测试与可观测性 | mock 模型 + 请求快照 + rollout-trace + OTel | 262 单测 + 14 e2e + 4 路 jsonl；无常规 CI | 中 | CI + 请求快照 + run 回放 |

---

## 2. Agent 循环

### Codex 怎么做

- **Op/Event 双向协议**：外部操作统一为 `Op` 枚举（`protocol/src/protocol.rs:650`：`Interrupt`、`TurnInput{mode}`、`ExecApproval`、`Compact`、`Review`…），UI 通知统一为 `EventMsg`（`:1464`）。核心只消费 Op、只产出 Event，不关心来源（TUI/App Server/API 同一套）。
- **会话 actor**：每会话 `async_channel::bounded(512)` 提交队列（`core/src/session/mod.rs:606`），`submission_loop` 用 `tokio::select!` 串行处理（`core/src/session/handlers.rs:439`），天然免重入。
- **单活跃任务**：`SessionTask` trait 只有 `kind/run/abort` 三个方法（`core/src/tasks/mod.rs:180`）；`spawn_task` 先 `abort_all_tasks` 再起新任务（`:272`、`:549`）——「换任务先杀旧任务」。
- **分层循环**：`RegularTask::run`（外层，可多次 `run_turn`）→ `run_turn`（`core/src/session/turn.rs:164`，抽样循环：每轮 drain pending 输入 → 调模型 → 工具 future 进 `FuturesOrdered` → `drain_in_flight` 等全部完成）→ 流重试循环。退出条件：`needs_follow_up || has_pending_input` 为假（`:562-574`）。
- **工具可并行**：流式过程中每个工具调用立即生成 future 并发执行，输出项经 `handle_output_item_done`（`core/src/stream_events_utils.rs:315`）回到循环。
- **流映射**：SSE → `ResponseEvent`（`codex-api/src/sse/responses.rs:344`）。

### 本项目现状

- **双路径不统一**：Claude 走 SDK `query()`（`src/integrations/claude.js:143`），循环/压缩/续接全托管；openai 走自研 `runAgentLoop`（`src/providers/agent-loop.js:25`）。
- openai 循环质量其实不错：`for(step<budget)`、`finishReason!=='tool-calls'` 退出、`canUseTool` 审批钩子、每步 `onMessages` 检查点（`:118-121`）、步数耗尽走「强制收尾」（禁用工具 + WRAP_UP_PROMPT，`src/entrypoints/web/run-openai.js:131-175`）而不是静默截断——这点比很多实现好。
- 弱点：① 工具**逐个串行**执行；② 循环本身**不重试模型错误**，直接抛出；③ 默认预算 `Infinity`（`resolveMaxSteps` 0/非法 = 不限，`run-openai.logic.js:66-69`）。

### 可借鉴

1. **引入流重试层**：模型请求失败按 Codex 策略指数退避（初 5s、上限 60s、最多 5 次、硬顶 100），把「重试」放在循环内层而不是甩给上层 run 重试（现在一次网络抖动人整个 run 走 2s 重试 + attempt+1，代价太大）。
2. **工具并行化**：只读工具（Read/Glob/Grep/WebFetch/RepoMap）在一批内用 `Promise.allSettled` 并发，写类工具保持串行——Codex 的 FuturesOrdered 模式可直接翻译。
3. **默认预算收敛**：`Infinity` 改为配置化默认值（比如 60 步），配合已有的强制收尾逻辑。
4. （低优先）把「Op 枚举」思想落到路由层：`/api/run/*` 已隐含 send/steer/abort/approve 操作集合，可以沉淀为一个 `runCommand` 判别联合类型，统一两条路径。

---

## 3. 长任务架构 ★

> 这是本项目最值得投入的维度。当前「run 能续跑」解决的是**崩溃生存**，Codex 解决的是**超长任务生存**——后者靠 token 预算、阶段化压缩、重试与计划外化。

### Codex 怎么做

**3.1 压缩是一等公民，且分阶段**

- turn 被显式建模为「PreTurn 检查 → 采样循环（MidTurn 检查）→ PostTurn 检查」，压缩挂载在固定阶段（`core/src/session/turn.rs`：Pre `:1327`、Mid `:628`、Post `:736`）。
- MidTurn 触发条件：`needs_follow_up && (take_new_context_window_request() || token_limit_reached)`（`:609-610`）。
- 手动 `/compact` 走独立 `CompactTask`（`core/src/tasks/compact.rs:18`）——同样是 SessionTask，复用调度与中断。

**3.2 阈值集中在一个模块**

- `ContextWindowTokenStatus`（`core/src/session/context_window.rs:8`）统一计算：`effective_context_window_percent` 默认 95、`auto_compact_token_limit` 缺省按窗口 90% 推导并钳制（`protocol/src/openai_models.rs:464-471, 525-537`）。调用点只消费布尔量，不存在「哪里都在算 90%」。

**3.3 压缩产出的结构固定**

- 本地压缩：摘要 prompt 要求四要素——**进度与决策、关键约束与偏好、待办下一步、继续所需的关键数据**（`prompts/templates/compact/prompt.md`）；历史重建保最近用户消息预算 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`core/src/compact.rs:63`）；摘要带 `SUMMARY_PREFIX` 前缀以便识别（`:383, 602`）。
- 远程 V2：保留预算 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`、单条 agent 消息上限 10_000 token（`core/src/compact_remote_v2.rs:73-74`）。
- 另有 `TokenBudget` 模式：只重置窗口不摘要（换窗式续跑）。

**3.4 失败恢复显式化**

- `ResponsesStreamRetryState`：初 5s、上限 60s（`core/src/responses_retry.rs:23-32`）、最多 5 次、硬顶 100、流空闲 300s 视为断流（`model-provider-info/src/lib.rs:66-73`）；重试基于当前历史重建请求，WebSocket 场景用 `previous_response_id` 增量续传。

**3.5 任务状态外化，供压缩后自恢复**

- `update_plan` 工具（`core/src/tools/handlers/plan.rs`）让模型维护计划；`get_context_remaining` + `new_context_window` 让模型主动感知预算并请求换窗；`CurrentTimeReminder` 定期注入时间。这些「世界状态」在压缩后由检查点重建。

### 本项目现状

- **run 级**：看门狗 15min 静默 / 2h 硬超时（`src/store/runs.js:19-22`）；openai 每步落盘检查点；崩溃后 `reconcileRuns` 分类 discard/resume/abandon、最多 3 次续跑（`src/entrypoints/web/run-reconcile.logic.js:20-53`）——这套对账是扎实的。
- **压缩**：openai 自研滚动摘要按**消息条数**触发（`COMPACT_TRIGGER=200`、`KEEP_RECENT=100`，`src/entrypoints/web/conv-compact.logic.js:13-17`）；Claude 完全依赖 SDK `autoCompactEnabled`（`src/entrypoints/web/run-claude.js:203`）。
- **缺口**：无 token 预算/熔断；usage 每步上报但刻意不落 journal（`runs.js:459-461`）；follow-up 队列纯内存、重启即丢（`runs.js:550-551`）；无计划持久化；无模型级重试策略；无「上下文将满」的主动提示。

### 可借鉴（落地方案）

**P0-① 建立 `src/capabilities/context-budget.js`（预算中心）**

- 复刻 `ContextWindowTokenStatus` 的角色：输入「模型可见消息数组 + 窗口大小」，输出 `{tokens, limit, ratio, overline}`。
- token 估算用 Codex 的字节启发式：模型可见文本 `bytes/4`；图片固定估值（Codex 用 7373 字节 ≈ 1844 token）。
- 阈值：窗口 90% 触发自动压缩（与 Codex 缺省一致），保留 5% 缓冲防挤爆。
- 窗口大小从现有凭证元数据取（`run-openai.js:362-367` 已在做），Claude 路径从 SDK usage 事件取后回填同一预算模块。
- 一处受益：把 usage 写进 run-journal（放开 `runs.js:459-461` 的限制），成本可见 + 为熔断提供数据。

**P0-② 压缩升级为「token + 条数」双触发，产出结构化摘要**

- 触发条件从纯条数改为：`estimatedTokens >= window*0.9 || messageCount > 200`。
- 摘要格式对齐 Codex 四要素（进度与决策 / 约束与偏好 / 待办与下一步 / 关键数据），并在摘要头部加固定前缀（如 `[COMPACTED]`）便于后续识别与调试。
- 保留策略分段：最近 ~100 条或 ~20k token（取先到者），更早内容进摘要——替代现在的纯条数切分。
- 压缩动作作为独立「任务」记录进 run-journal（`type:'compaction'`），让对账/回放能看见压缩点。

**P0-③ 模型流重试策略进 `agent-loop`/model 层**

- 指数退避 2s→60s、最多 5 次；SSE 空闲超时（如 120s）判死重建请求——现在的 e2e 假 SSE 端点正好可以扩展一个「挂起流」用例。
- 参照 Codex：重试前基于当前 `convo` 重建请求（天然幂等），重试事件写入 journal。

**P1-④ 计划外化：持久化 follow-up 队列 + 任务 plan**

- follow-up 队列落盘（`conv-inbox` 已有磁盘结构可复用，`runs.js:550-551` 目前纯内存）→ 重启后由对账恢复排空。
- 引入轻量 plan：模型可调 `update_plan` 工具维护 checklist，plan 存 conv 级存储，压缩/续跑后重新注入——这是 Codex 对抗「压缩失忆」的核心手段，成本极低。

**P1-⑤ 压缩阶段化**：把「压缩检查」从当前 run 循环中间的条件分支提升为显式阶段（每步开始前 / 工具批次结束后），与预算中心配合，让行为可预测、可测试。

---

## 4. 上下文管理 ★

### Codex 怎么做

- **单一 ContextManager，存全量、发裁剪**：`ContextManager::history` 记录全部条目；`for_prompt`（`core/src/context_manager/history.rs:603`）发送前必过 normalize（`:969-976`）：
  - `ensure_call_outputs_present`：每个工具调用必须有输出（缺则补占位）；
  - `remove_orphan_outputs`：孤立输出删除；
  - `strip_images/audio_when_unsupported`：模态不支持则裁剪。
- **廉价预算**：`estimate_item_token_count`（`history.rs:1072`）按「模型可见字节 ÷ 4」；图片固定 `RESIZED_IMAGE_BYTES_ESTIMATE = 7373`，仅 `detail:original` 才按 32px patch 实算（`:1081-1089`）。
- **world-state 差分注入**：环境/指令类信息只发变化量（`core/src/context/world_state/mod.rs:163`），环境节仅报告 cwd/shell/日期/时区/网络/文件系统变化（`environment.rs:113`）；并保存检查点（`history.rs:491`）供压缩后重建基线。
- **截断有策略**：`truncate_text` 用「保头尾丢中间」（`utils/output-truncation/src/lib.rs:36`）；多模态输出按剩余预算分配（`:164`）；项目文档硬预算 32KiB（`config/src/config_toml.rs:75`）。
- **UI 历史与模型上下文分离**：`message-history` crate 单独的 append-only 历史，不进模型输入。

### 本项目现状

- 存储：Claude 历史在 SDK session JSONL；openai 在 `conv-messages.json`（磁盘 backstop `MAX_STORED=1000`，头部裁到非 tool 边界 `conv-messages.js:49-56`）。
- 截断：散落在工具层的硬常量——Read 2000 行/50KB、Bash 30k 字符、子代理结论 8000 字符、repo-map 6000 字符、journal 2000 字符（`builtin-tools.js:28-42` 等）。
- 有亮点的部分：`repairDanglingToolCalls` 把悬空 tool-call 合成「未执行」占位并落盘（`run-openai.logic.js:22-59`）——这其实就是 normalize 的雏形；`clipMiddle`（60/40 头尾保留，`conv-compact.logic.js:25-28`）与 Codex 的中段截断同思路。
- 缺口：token 只上报不进预算；无发送前规范化（悬空修复只在特定路径触发）；无世界状态/环境差分的概念；截断常量分散、无统一优先级。

### 可借鉴（落地方案）

**P0-① 发送前 normalize 函数（`src/capabilities/context-normalize.js`）**

- 把 `repairDanglingToolCalls` 泛化为每次构建请求前都跑的不变量集：
  1. `ensureCallOutputs`（已有雏形，推广）；
  2. `removeOrphanOutputs`；
  3. `dedupe/trim`：空消息、超长单条消息的中间截断（复用 `clipMiddle`）；
  4. `stripUnsupported`：当前模型不支持的附件/图片。
- 收益：两条路径（openai/Claude 的本地补丁）都能用，且可单测。

**P0-② 预算感知的截断优先级**

- 在预算中心（3-P0-①）里定义「每类来源的硬预算表」：系统提示、CLAUDE.md/规则、repo-map、skills 目录、单条工具输出、单条历史消息——对齐 Codex 每源独立硬预算的思路。
- 工具输出统一走「中间截断 + 省略标记」，替代各处散落常量（保留个别更严的例外，如 Read 行数限制）。
- 状态行：向模型暴露 `get_context_remaining` 式只读工具（或每步在系统提醒里附一行预算），让模型自己收敛行为。

**P1-③ 环境信息差分注入**

- 现在环境信息（cwd、git 分支等）若每轮全量注入，浪费且干扰。借鉴 world-state：只在变化时注入一小节（`<env changed: branch feature/x → main>`），并在压缩后重建基线。
- 已有 `CurrentTimeReminder` 对应物吗？本项目可以低成本加一个：长时间运行的 run 每 N 分钟注入时间提醒（对 bug-patrol 这类循环尤其有用）。

**P1-④ 存储与发送视图分离**

- `conv-messages.json` 同时承担「存储」与「发送」两个角色——建议显式分成 `stored`（全量，含 summary 覆盖区）与 `forPrompt(convId)` 构建函数（内存视图），发送前必经 normalize + 截断 + 预算。Claude 路径则是「SDK 管发送，自己管 transcript」，保持一致的关键是把本项目的 journal 作为统一账本（见持久化章节）。

---

## 5. 多 Agent 协作 ★

### Codex 怎么做

**5.1 形态：同进程多线程，不是多进程**

- 子 agent = ThreadManager 管理的**新线程**，独立 Session（对话史、工具路由、配置快照），共享父进程事件循环、工具运行时与 MCP 连接（`core/src/agent/control/spawn.rs:836 spawn_child_thread`）。
- 配置继承后覆盖 model/reasoning，父的 approval_policy、cwd、权限快照抄入子会话（`core/src/agent/child_config.rs:179-202`）。

**5.2 工具面（对模型暴露的 API）**

- V1 `multi_agent_v1`：`spawn_agent` / `send_input` / `resume_agent` / `wait_agent` / `close_agent`。
- V2：`spawn_agent` / `send_message` / `followup_task` / `wait_agent` / `interrupt_agent` / `list_agents`（`core/src/tools/handlers/multi_agents_spec.rs:14`）。
- `spawn_agent` 必填 `task_name` + `message`，可选 `fork_turns(all|none)`、`agent_type`、`model`、`reasoning_effort`；返回 `{task_name, nickname}`。
- `send_message` 只入队（QueueOnly）；`followup_task` 触发新 turn（TriggerTurn）——同一实现两个语义（`multi_agents_v2/message_tool.rs:42-101`）。

**5.3 通信：邮箱模型**

- 父→子：`AgentControl::send` + `InterAgentCommunication{trigger_turn}`；未加载子 agent 的邮箱保留（`core/src/agent/control/mailbox.rs`）。
- 子→父：终结结果生成为「完成消息」，**截断 1000 token** 后以 queue-only 投递父线程（`control/completion.rs:27-154`、`session_prefix.rs:20-37`）——父上下文不被子 transcript 污染。

**5.4 监督：状态机 + 上限**

- `AgentStatus{PendingInit, Running, Interrupted, Completed, Errored, Shutdown, NotFound}`（`protocol/src/protocol.rs:1932`），由事件流归约（`core/src/agent/status.rs:6-24`）。
- 并发上限：V1 max threads = 6、V2 每 session 并发 = 4、max depth = 1（`core/src/config/mod.rs:254-264`）。
- `wait_agent` 带 `timeout_ms`（默认 30s、最小 10s、最大 3600s，`multi_agents_common.rs:22-24`）。
- **角色只能降权**：内置 `default/explorer/worker`，角色禁 Shell/Apps/Memory 等技能（`core/src/agent/role.rs:91-117, 342-407`）。

**5.5 周边**

- 层级任务命名（`/root/task1/task_3`，`multi_agents_common.rs:141-165`）——可列表、可寻址、可定向中断。
- `agent-graph-store`：父子边（图存储）；`agent-message-board-client`：远端讨论板（best-effort，BoardNotification 绑定 turn）。
- `guardian`：独立评审会话（`core/src/guardian/`），对父 agent 的变更给结构化评审。
- collab mode 模板：Plan/Default 两套 developer 指令；MultiAgentMode `proactive|explicit` 决定是否主动派活（`core/src/session/multi_agents.rs:77-121`）。

### 本项目现状

**已有的（比想象中多）**

- openai 路径：只读子代理白名单 6 工具（`Read/Glob/Grep/WebFetch/WebSearch/RepoMap`，`subagent.logic.js:12`），子集不含 Task/Workflow → 天然禁递归；Task/Workflow 由主 run 承载，复用审批与 abortController。
- Workflow 编排：4 阶段 × 6 / 总 12 子任务、并发 3、阶段内并行、结论裁剪 2000 字符/总 12000（`workflow.logic.js:23-30`）。
- 同事 agent：限流（5 条/60s、全局并发 2）、session 续接落盘、ACK 兜底（`colleague-agent/session.js`）。
- 无人值守：auto-dev 泵 5s tick + 全局单飞；bug-patrol 30s tick/12h 上限；合并队列按 repo 串行 + worktree 隔离（`merge-queue.js`、`colleague-dev.js`）。
- Claude 路径：SDK 原生 Task/Agent（`tool-policy.logic.js:254` 放行）。

**缺口**

- **两套路径无统一 agent 抽象**：openai 的 subagent/workflow 与 Claude 的原生 Task 各写各的。
- **无通信**：子 agent 启动后无法再发消息/追问；无 mailbox；无「继续任务」。
- **无状态**：没有 agent registry/状态机；子任务状态只在 run 内存与 journal 事件里，无法 `list_agents` 或跨 run 查询。
- **无角色/预算**：子代理只有「只读」一档；无 per-agent token/时间预算。
- **结果只有文本**：结构化产出（改了哪些文件、验证结论）靠 8000 字符截断重述。

### 可借鉴（落地方案）

**P1-① 统一 `AgentHandle` 抽象（`src/capabilities/agent-registry.js`）**（2026-10-16 已落地：openai 路径的 Task/Workflow 子代理全部登记；Claude 路径待接）

```
AgentHandle = {
  id, taskName（层级命名，如 /root/explore-1）,
  provider（openai-subagent | claude-task | colleague | workflow-step）,
  role（explorer | worker | default）,
  status: PendingInit → Running → Interrupted | Completed | Errored,
  mailbox: [messages], budget: {tokens, turns, deadline},
  artifacts: {summary, changedFiles}
}
```

- 状态转换写入 run-journal（新事件类型 `agent_status`），对账时能重建；`list_agents` 工具读注册表。
- 这是「统一两条路径」的最小代价方案：不重构执行，只加一层登记与查询。

**P1-② 补齐通信语义：`send_message` + `wait` + `interrupt_agent`**（2026-10-16 已落地，见 §14 的对应实施状态：工具名取 Codex V2 的 `wait_agent`；`send_message` 合流了 QueueOnly/TriggerTurn 两个语义——运行中入邮箱、当前轮结束一定自动接续，空闲则直接起新一轮）

- openai 子代理目前只读且一次性——先给只读子代理加 mailbox：宿主循环（`runAgentLoop` 或 workflow 调度器）在子代理结束后保留 handle，`send_message`（QueueOnly/TriggerTurn 两语义）可继续追问。
- `wait` 带 `timeout_ms`（对齐 30s 默认），超时返回「仍在运行」而不是阻塞。
- 中断语义：`interrupt_agent` 复用主 run 的 abortController 派生 signal。

**P1-③ 角色降权模型**

- 定义 `src/capabilities/agent-roles.js`：角色 = 工具白名单 + 预算 + 沙箱档次，只允许从父收窄不允许放宽（Codex 规则）；与 `tool-policy.logic.js` 六档矩阵打通。
- 现有「只读白名单」就是 `explorer` 角色的雏形，把它显式化为可配置角色表即可。

**P1-④ 完成协议**

- 子 agent 结束回传结构化 `{status, summary, artifacts, changedFiles, tokenUsage}`；summary 保持有界（对齐 Codex 1000 token ≈ 4000 字符，现有 8000 字符可收紧或配置化）。
- 关键：**结果以「完成消息」进父上下文，而不是整段 transcript**——本项目已经是这样，只需结构化。

**P2-⑤ 共享黑板（可选，低优先）**

- 本项目已有 `colleague-messages.json` 与 run-journal 两个 append-only 通道；如果未来多 agent 需要共享发现（比如 bug-patrol 与 auto-dev 看到同一份结论），复用 journal 加 `board` 事件类型即可，不必引入新服务。
- Codex 的 `agent-graph-store`（父子图）对本项目价值有限，层级命名 + 注册表已覆盖大部分需求。

**P2-⑥ Guardian 评审模式**

- 本项目 `verifier.js` 与 `bug-patrol/side-review.js` 已是雏形；可对齐 Codex guardian：**独立会话**评审主 agent 的变更，产出结构化 verdict，评审会话不污染主上下文。

---

## 6. 项目规则

### Codex 怎么做

- **AGENTS.md 发现链**：以项目根 marker（默认 `.git`）为起点、从根到 cwd 逐层拼接，`AGENTS.override.md` 优先，`--- project-doc ---` 分隔，默认 32KiB 截断，不受信项目跳过（`core/src/agents_md.rs`，注入为 contextual user fragment `:473`）。
- **缓存**：按「环境 + 信任级」缓存，thread 指令上限 10k token（`core/src/agents_md_manager.rs`）；跨线程共享按 root 提供（`thread_manager/shared_instructions.rs`）。
- **Skills 渐进披露**：SKILL.md YAML frontmatter（name/description）；系统提示只放 `<skills_instructions>` 目录（名称+描述），正文按需读取（`ext/skills/src/catalog_prompt.rs:3-40`）。
- **Hooks**：12 个生命周期事件（PreToolUse/PermissionRequest/PostToolUse/PreCompact/PostCompact/SessionStart/SessionEnd/UserPromptSubmit/SubagentStart/SubagentStop/Stop/Interrupt，`hooks/src/lib.rs:23-36`），支持 command 或 MCP 处理器。
- **Memories**：后台两阶段（逐 rollout 提取 → 全局整合），仅根会话运行（`memories/README.md`）。
- **提示词分层**：bundled 基座 + 目录覆盖 + model catalog + 模式模板（`promptscrate`）。

### 本项目现状

- CLAUDE.md：根 + 10 个 src 子目录；`claude-md.js:23,37-41` 只做幂等 @ 引用追加（不复制内容），Claude SDK 自动加载。
- memory-bank：两阶段提炼 → 渲染到 `~/.claude/memory-bank.md` 与 `<dir>/.claude/memory-bank.md` → 挂 @ 引用；空内容写空文件防旧规则复活（`memory-bank/index.js:44-70`）——细节做得不错。
- repo-map：git-only、增量、4s 预算、fail-open；enabled 时注入 openai system prompt 并注册 RepoMap 工具（`run-openai.js:181-216`）。
- skills：superpowers 作为 SDK plugin 注入；停用技能时物化「启用视图」镜像（`builtin-skills.js:86-91,167-172`）。
- 缺口：无 AGENTS.md 兼容；无「按任务/角色裁剪规则」机制；openai 路径不读 CLAUDE.md/rules（只有 buildAgentSystemPrompt + repo map）。

### 可借鉴

1. **AGENTS.md 兼容**：发现链（根→cwd 逐层 + override）实现成本低，复用 `repo-map` 的 git 根探测；注入到 openai 路径的 system prompt。
2. **规则合并器 + 缓存**：按「目录 + 信任级」缓存合并结果（含字节截断），避免每 run 重读；参考 `agents_md_manager` 的失效策略。
3. **生命周期 hooks**：本项目插件系统已有装配点，可对齐 Codex 事件表最实用的几个：PreToolUse（策略拦截）、PostToolUse（action-log）、SessionStart/End、SubagentStart/Stop、PreCompact/PostCompact。工具策略目前只能拿 openai 路径的 canUseTool，hooks 能让 Claude 路径在 SDK hook 点做同样的事（SDK 提供 PreToolUse hook）。
4. **skills 渐进披露对齐**：内置 skills 注入目录（名称+描述），正文按需读取——与 superpowers 机制一致，保持即可；为 openai 路径补一个轻量 skills 目录注入。

---

## 7. 权限沙箱

### Codex 怎么做

- **两个正交枚举**：
  - `AskForApproval`（`protocol/src/protocol.rs:1092`）：`UnlessTrusted`（除非规则明确允许否则一律问）/ `OnRequest`（默认）/ `Granular`（五类子开关，关掉的类别自动拒绝而非弹窗）/ `Never`（从不弹窗）。
  - `SandboxPolicy`（`:1178`）：`DangerFullAccess` / `ReadOnly{network}` / `ExternalSandbox` / `WorkspaceWrite{writable_roots, network, ...}`；`read_only_subpaths` 专门保护 `.git/hooks` 这类可提权路径（`:1234`）。
- **平台实现**：macOS seatbelt、Linux bubblewrap+seccomp（网络受限时禁 `connect/ptrace/io_uring_*`，`linux-sandbox/src/seccomp.rs:185-210`）、Windows 受限令牌/新 MXC；`process-hardening` 启动前禁 core dump、清 `LD_*`。
- **命令规则（execpolicy）**：Starlark 文件 `$CODEX_HOME/rules/default.rules`，`prefix_rule(pattern, decision="allow"|"prompt"|"forbidden")`、`network_rule`；多段命令逐段匹配、**取最严**（`Decision::max`，Allow<Prompt<Forbidden，`execpolicy/src/policy.rs:402`）；危险命令（bash -c、node -e）不会被建议「总是允许」（`exec_policy.rs:57-119`）。
- **审批三态**：工具声明 `ExecApprovalRequirement{Skip{bypass_sandbox}, NeedsApproval, Forbidden}`（`core/src/tools/sandboxing.rs:154, 326-359`）；审批决策有会话缓存 + 「总是允许」追加规则到 `default.rules`（`amend.rs:65-81`）。
- **网络**：统一走本地代理注入 env（`HTTP(S)_PROXY` 等，`network-proxy/src/proxy.rs:607-641`），按域名/协议 Allow/Deny/Ask 并审计。
- **apply_patch 独立三态**：`SafetyCheck{AutoApprove,AskUser,Reject}`，路径全在可写根即自动放行（`core/src/safety.rs:19-125`）。

### 本项目现状

- 角色门：guest=1/owner=2，缺失/非法 fail-closed 收窄到 owner（`action-permission.js:18-38`）。
- 工具策略：六档 LEVEL_CAPS 矩阵 + 危险命令 deny 名单 + 阻断上限 3（`tool-policy.logic.js:38-52,115`）。
- 容器 Bash（仅 openai）：docker/podman 探测，`--network none`，不可用 fail-closed（`exec-backends.logic.js:31,50`）。
- **明确缺口（文件头自认）**：Claude 路径 `bypassPermissions` 下 SDK 不回调 `canUseTool`，deny 名单拦不到（`tool-policy.logic.js:35`）；Claude Bash 不容器化。→ **deny 名单部分已于 2026-10-11 补上**（`buildClaudePretoolHook`：bypass 档挂 PreToolUse 钩子守卫，见 `specs/2026-10-11-claude-bypass-deny-guard-design.md`）；Bash 不容器化仍维持现状。

### 可借鉴

1. **Claude 路径补上策略执行点**：两条路选一——① SDK 的 PreToolUse hook 里执行 `tool-policy` 判定（推荐，Claude Agent SDK 支持挂 hook）；② 在 MCP/内置工具包装层做前置拦截。不要让 `bypassPermissions` 成为策略真空。**→ 已落地（2026-10-11，走①）**：`capabilities/tool-policy.js#buildClaudePretoolHook` 动态档位钩子（default 恒 ask / bypass 只拦 deny 名单 / 其余不表态），`run-claude.js` 与 `buildUnattendedClaudeOpts` 均接线。
2. **审批记忆/规则文件**：把「总是允许」的决策持久化（类似 `settings.json` 下的 rules），Codex 的做法是追加成 prefix 规则文件；本项目可在 `tool-policy` 基础上加「命令前缀规则表」+ 会话缓存。
3. **三态审批语义**：把现有「允许/拒绝/阻断」枚举化，工具声明自己的需求档次；对 apply_patch 类写工具用「可写路径集合判定」替代命令前缀匹配。
4. **沙箱档次显式化**：read-only / workspace-write / full 三档映射到现有执行后端；容器 backend 从 openai Bash 推广为共享组件（Claude 路径的 Bash 可经同一 exec-backends 执行）。
5. 网络策略维持现状（`--network none`）即可，除非将来需要 npm install 类操作再引入代理 allowlist。

---

## 8. 长命令管理

### Codex 怎么做

- **会话化执行**：`exec_command` 启动进程并最多等待一个 yield 时间片（`MIN_YIELD_TIME_MS=250ms`、`MAX_YIELD_TIME_MS=30s`、默认 10s），未结束则返回 `process_id`；模型用 `write_stdin` 继续轮询/写入（`core/src/unified_exec/mod.rs:68-77`，`process_manager.rs:522/879`）。
- **上限**：并发进程 ≤ 64、后台超时 300s、单次输出 1MiB、流式增量 ≤ 8KB、进程退出后 100ms 宽限收尾（`mod.rs:68-77`、`async_watcher.rs:34-42`）。
- **输出保留**：头尾各半缓冲 + 省略标记（`head_tail_buffer.rs`）。
- **一次性 vs 交互式**：`OneShot` 跑完即止（默认超时 10s，`core/src/exec.rs:63`）；`Interactive` 返回可恢复会话（`exec_command.rs:69`）。
- **stdin 审批**：敏感输入（如沙箱升级）走审批（`stdin_approval.rs`）。
- **exec-server**：可选把命令执行服务化（JSON-RPC：Initialize/Exec/Read/Write/Signal/Terminate），进程隔离。

### 本项目现状

- Bash 工具仅超时强杀（默认 120s / 上限 600s），Windows 杀进程树（`builtin-tools.js:273-354`）。
- 无后台/持久 shell、无进程会话、无增量输出轮询——长命令（`npm run dev`、构建、跑测试）只能等或杀。

### 可借鉴（高性价比）

**P1-① 命令会话管理器（`src/providers/exec-sessions.js`）**

- 对齐 Codex 形态：`exec_command(cmd, {yieldMs})` → 返回 `{processId, output, running}`；未结束时保留 pipe，提供 `write_stdin(processId, input, {yieldMs})` 轮询输出。
- 缓冲用头尾双保留 + 省略标记；单次增量 ≤ 8KB；进程数上限 + run 结束时 `terminateAll`（本项目已有 abort 杀进程树逻辑，可复用）。
- 这直接给 agent 打开「跑 dev server / 长构建 / 交互式命令」的能力，是长任务架构的配套能力。

**P1-② 工具面**：`exec_command`（已有 Bash 的替代/补充）、`write_stdin`、`list_processes`、`kill_process`。YIELD 默认值建议 10s。

**P2-③**：如果将来需要把执行放到远端/容器，再考虑 exec-server 式 RPC 分层；当前 docker/podman backend 已够用。

> **实施状态（2026-10-11）**：P1-①② 已落地——`src/providers/exec-sessions.logic.js`（纯函数：头尾双保留缓冲 + 消费式 8K 读取 + `yield_ms` 夹取 + 文案）+ `src/providers/exec-sessions.js`（运行时：spawn/登记表/`terminateAll`，复用 T6 的 `makeBashSpawn` 与共享 `killTree`）。工具四件套 `exec_command`/`write_stdin`/`list_processes`/`kill_process` 在 `run-openai.js` 装配（**不进 builtin 恒有七件套**——`llm-openai-agent` 等辅助通道按白名单挑工具，不受影响）。yield 默认 10s（250ms–30s）、write_stdin 默认 5s、单次读取 ≤ 8KB、缓冲头 16K+尾 112K；per-run 上限 8 会话（满员先回收已退出，全在跑明确拒绝）；run 终结（finally）与 abort 信号**双保险 `terminateAll`**，不留孤儿进程。策略：`exec_command` 归 `EXEC_TOOLS`（与 Bash 同一裁决路径），会话控制类新增 `session` 类（除 plan 外放行——进程只能来自已审批的 `exec_command`；`write_stdin` 写入内容命中危险名单降级 ask）；UI 一行开关（`exec_command`）管整族。P2-③（exec-server）维持不做；spec 见 `docs/superpowers/specs/2026-10-11-exec-sessions-design.md`。

---

## 9. 工具按需加载

### Codex 怎么做

- **exposure 分级**：Direct（常驻）/ Deferred（进检索）/ CodeModeOnly / Hidden；每个 turn 由 `build_tool_router` 组装「工具计划」（`core/src/tools/spec_plan.rs:121-186`）。
- **tool_search**：对 name+description+schema 建 BM25 索引，默认返回 8 条；结果以 `ToolSearchOutput` 项注入下一轮调用（`tool_search.rs:167-176`、`tools/src/tool_discovery.rs:6-7`）。模型先搜后用，工具多也不挤占常驻上下文。
- **MCP 默认 Deferred**（`mcp_tool_exposure.rs:84-88`）；`dynamic.rs` 中 `defer_loading` 工具同理。
- **MCP 生命周期**：运行时 ArcSwap 原子替换（`codex-mcp/src/runtime.rs:100-131`）、prewarm 合并请求（`mcp_prewarm.rs`）、工具目录 LRU 32 条/TTL 30min（`tool_catalog_cache.rs:33-34`）；主会话 Eager、subagent LazyWhenCached。
- **features registry**：集中注册 + 每 turn 检查（`features/src/lib.rs`）。

### 本项目现状

- run 启动时一次性装配（openai `run-openai.js:209-259`）；MCP 每 run 连接、握手 20s、abort 杀子进程（`mcp.js`）。
- 已有部分「条件装配」：RepoMap、Workflow、内置 MCP、skills 启用视图镜像、插件停用即不加载（`plugins/index.js:45-90`）。
- 缺口：无工具检索、无延迟暴露、MCP 无目录缓存/prewarm；工具数量再多会线性挤占上下文。

### 可借鉴

1. **工具注册表加 exposure 元数据**：给每个工具（内置/插件/MCP）标记 `direct | deferred | hidden`；每 run 构建「工具计划」——现状的条件装配正是雏形，把它收敛成一个 `buildToolPlan({provider, mode, conv})` 函数。
2. **按需检索**：工具总量（含 MCP）超过阈值时，引入 `tool_search` 工具（Node 侧 BM25，如 minisearch），deferred 工具的 schema 只在检索命中后注入下一轮——这是 Codex 方案在本项目的直接翻译。
3. **MCP 目录缓存 + 预热门**：cache 工具清单（LRU+TTL），run 启动用缓存先装配、后台刷新（单写者）；子代理/同事 agent 默认懒加载（LazyWhenCached）。
4. **features 开关集中化**：把散落的「是否注入 RepoMap/Workflow/内置 MCP」判断提到一个 registry，便于灰度和测试。

---

## 10. Code Mode

### Codex 怎么做

- 模型不再一轮一次 function calling，而是写一段 JavaScript，宿主 V8 执行；对模型只暴露两个工具：`exec`（输入裸 JS，可带 `// @exec: {...}` pragma）与 `wait`（`code-mode-protocol/src/lib.rs:54-55`）。
- 代码里通过全局 `tools.<name>()` 调用真实工具（`globals.rs:15-59`），支持循环、并发、先 `tool_search` 再调用；嵌套调用走正常工具管线，**审批与沙箱照旧**。
- 运行时：rusty_v8，每 cell 新 Isolate + 监督线程（`code-mode-runtime/runtime/mod.rs:130-143`）；宿主可进程内或独立子进程（`codex-code-mode-host --listen grpc+stdio://`），gRPC/帧协议（`code-mode-protocol`）。
- 安全：删除 `console/Atomics/SharedArrayBuffer/WebAssembly`，仅内部 import，cell 跑完即销毁；yield 默认 10s、输出默认 10k token、host 并发上限 256 in-flight / 128 cells。
- 动机：工具数量爆炸（MCP 生态）时，function calling 的上下文成本与往返次数都不可接受。

### 本项目现状

- 无对应实现。最接近的是 Workflow（多子任务编排）与 `runAgentLoop`（多步工具调用）。

### 可借鉴

- **不建议近期自研 Code Mode**（V8 隔离/协议/多语言沙箱成本高，本项目工具面还没到需要它的规模）。
- 可借鉴其**两个思想**：
  1. `tool_search` + deferred 暴露（见第 9 节）——解决工具挤占上下文；
  2. 「编排进宿主代码」——Workflow 已经是这个方向的简化版（阶段/并发/上限由宿主控制而非模型），保持宿主控制、模型填内容的路线即可。
- 若未来确实要做，Node 下的最小可行形态是：worker_threads + 受限全局 + 工具白名单桥接，协议先内部私有——但优先级应排在 P2 之后。

---

## 11. 运行干预

### Codex 怎么做

- **steer**：`TurnInputMode::Steer{expected_turn_id}`；`Handle` 链 `turn_input.rs:230→328→634→803`；仅 `TaskKind::Regular` 可 steer（Review/Compact 拒绝，`:NotSubmittedReason::ActiveTurnNotSteerable`）；输入进 `pending_input`，且 `watch_user_input`（`session/input_queue.rs:293`）在输入到达时 **cancel preempt token 提前切断当前采样流**，保证循环尽快取到新输入。
- **interrupt 两阶段**：`Op::Interrupt` → `abort_all_tasks` → `handle_task_abort`：先 cancel，等最多 100ms 优雅窗口（`GRACEFULL_INTERRUPTION_TIMEOUT_MS`，`tasks/mod.rs:71`），超时硬 abort；随后**先写中断 marker 并 flush，再发 `TurnAborted`**（保证 UI 收到中断时历史已可恢复）。
- **审批悬停**：`insert_pending_approval` → 发事件 → `rx_approve.await`；`Op::ExecApproval` 唤醒；中断时 `clear_pending_waiters` 统一清空（`state/turn.rs:135`），避免 Promise 永挂。

### 本项目现状（并不弱）

- steer（Claude）：holdMsg 持有区 → 本轮 result 时 `flushHeldMsgs`（`runs.js:506-517`）；`/api/run/msg/now` 先 flush 再 `q.interrupt()`（`routes-run.js:325-348`）；撤回仅对未消费消息可用；用户纠偏信号有专采。
- follow-up（openai）：conv 级队列，run 终结后 conv-inbox 排空起新 run（`conv-inbox.js:44-111`）。
- abort：`stopRun`/看门狗；5s 巡检、插话/排队视为活动；飞书补充单槽 TTL 10min。
- 审批队列 + 卡片链路完整。

### 可借鉴

1. **steer 抢占当前流（openai 路径）**：现在 follow-up 要等 run 终结；可对齐 Codex——steer 消息到达时 abort 当前模型请求，把消息并进 `convo` 立刻重发。Claude 路径已有 `q.interrupt()` 先例。
2. **中断也写历史**：本项目停 run 收尾为中性 `stopped`；建议明确「先写 journal 中断 marker + flush，再发 SSE settle 事件」的次序，恢复时以 marker 判断。
3. **steer 白名单**：对齐 Codex——memory-bank/compaction/verifier 等非对话任务期间拒绝 steer（现在按 capabilities 分流，可扩展「任务类型」维度）。
4. **等待者集中管理**：审批/飞书 ask/pending-supplement 的 pending resolver 建议统一登记，abort 时集中清空（目前分散），防止偶发永挂。

> **实施状态（2026-10-11）**：本文 1（steer 抢占当前流）已落地——openai 起跑/续跑置 `capabilities.steer=true` + `steerMode='step'`（替换原 follow-up 排队路由）；`agent-loop` 在**步边界**取走持有插话并入对话（`takeSteerMessages` → `consumeHeldMsgs(run,'step')`，落检查点），且本轮 attempt **尚无可见产出**时 steer 到达即**抢占切断当前模型请求**、同一步号重来（`shouldPreempt` + 250ms 轻量巡检；已产出则等本轮结束再注入，绝不产生「界面有、历史无」的半截输出）。未消费兜底沿用 Claude 语义（unsent 标记 + 飞书登记 conv 自动重注入）。spec 见 `docs/superpowers/specs/2026-10-11-openai-step-steer-design.md`。

---

## 12. 持久化与恢复

### Codex 怎么做

- **唯一事实源**：rollout JSONL（`~/.codex/sessions`）同时承载对话历史与 UI 事件流；`RolloutLine{timestamp, ordinal, item}`，`RolloutItem` 12 类（SessionMeta/ResponseItem/InterAgentCommunication/Compacted/TurnContext/TokenUsageRecord/WorldState/EventMsg…，`history/src/lib.rs:215-369`）。解析必须走规范解析器，刻意为演进留余地。
- **写恢复**：flush 失败重建 writer 重试一次，仍失败保留未写后缀（`rollout/src/recorder.rs:1834`）；跨进程单写者锁（`writer_lock.rs`）；新 thread 首次写入才物化文件。
- **恢复语义**：`InitialHistory{New, Cleared, Resumed, Forked}`（`history/src/lib.rs:388`）；`RolloutReconstruction` 重建历史/设置/世界状态（`rollout_reconstruction.rs:208`）；从最后事件推断「被打断」（`mod.rs:1634-1645`）；fork 支持 `TruncateBeforeNthUserMessage`（`thread_manager.rs:202`）。
- **崩溃对账**：关机写 recovery snapshot；重启校验「末个 TurnStarted == saved.turn_id 且其后无终态事件」→ 补写 `TurnAborted` → 注入 `source="daemon_recovery"` 内部上下文续跑（`daemon_continuation.rs:23`）。
- **元数据**：SQLite 镜像（thread 列表/索引），与 rollout 分工。

### 本项目现状

- 已有：run-journal（事件流，5000 条/3 天）、run-index（落盘锚点）、pending-resume（waiting→resuming→done/abandoned）、对账分类（discard/resume/abandon，≤3 次）、submissions 幂等（requestId TTL 24h、60s 死认领复占）、多实例守卫（按 pid 分区）。
- 缺口：① 多份状态源（conv-messages、run-journal、transcript、SDK session 各管一摊）；② journal 同步写（appendFileSync）；③ 无 fork（从某条消息重开分支）；④ 无工具级幂等——崩溃在工具执行中时副作用无法判定（现在只把悬空调用标「未执行」，对已执行未确认的情况无处理）。

### 可借鉴

1. **唯一事实源归拢**：以 run-journal 为「事实流」，conv-messages 等降级为投影（读时构建）。目标：对账/回放/UI 都读同一份；这是 Codex 最重要的持久化原则，也直接提升「恢复正确性」的可证明性。
2. **写恢复模式**：journal/store 写入加「失败重试一次 + 保留 pending 后缀」的恢复模式，替代现在的同步直写。
3. **fork 语义**：对话级 fork（从第 N 条用户消息截断重开）——对本项目「老板重新跑需求」「回滚实验」场景价值高；现有 git 分支选择器 + worktree 基础可复用。
4. **工具级幂等**：执行前记录 `tool_intent`，完成后记 `tool_result`；恢复时三态处置：未执行（重跑）/已执行（跳过）/未知（对幂等工具重跑、对危险工具改为询问）。至少先给写类工具（Write/Edit/Bash 变更类）加意图-结果对。
5. **增量/延迟落盘**：SubagentSpawn/TurnStart/Steer 这类事件用后台批量写，热路径减同步 IO。

---

## 13. 测试与可观测性

### Codex 怎么做

- **分层**：crate 内 `*_tests.rs` 单测 → `core/tests/all.rs` 单二进制集成套件（240 个文件，真实 agent loop + mock 模型）→ insta 快照（全仓 1500+ 个 .snap）。
- **mock 模型**：wiremock + SSE 构造器 `ev_function_call`/`ev_completed`，安装函数 `mount_sse_once`/`mount_sse_sequence`；**断言点在「模型实际收到的请求」**，快照前用 `rewrite_known_segments` 抹平易变段。
- **环境适配**：TestEnvironment Local/Docker/WineExec，同一用例可在容器里验沙箱行为。
- **可观测**：OTel span 统一 `codex.*` 命名（`codex.turn_ttft`、`codex.api_request`、`codex.tool_decision`…）+ analytics 结构化 facts + rollout-trace（opt-in 本地调试 bundle：manifest+trace.jsonl+payloads，离线 reducer 产出语义图，**observe first, interpret later**，绝不上传）+ feedback 打包 rollout。
- **回放**：`codex resume` 从 rollout 恢复；debug sandbox 子命令直接验证沙箱；doctor 输出诊断。
- **CI**：nextest archive 分片跨 5 平台。

### 本项目现状

- 262 个单测（分布广）、14 个 e2e（含假 OpenAI SSE 端点验证对账续跑 `e2e-openai-resume.mjs`）、SWE 式 benchmark（手动跑）。
- 日志：logger + 4 路 jsonl（action/event/user/bot）；run-journal 只被对账读取，缺 run 级查询/回放视图。
- 缺口：无常规 CI（仅 release.yml）；无真实模型回归（benchmark 手动）；usage 不落 journal；无请求级快照测试。

### 可借鉴

1. **加常规 CI（成本最低收益最高）**：PR 上跑 `npm test` + e2e 子集 + lint。Codex 的平台矩阵暂不需要，但「测试必须过」应有门禁。
2. **请求快照测试**：复用现有假 SSE 端点，对「N 步后的模型可见请求」做 insta 式快照（本项目可用 JSON 文件 + 自定义 normalize）。这可精确锁定上下文组装/压缩/截断的回归——正好补第 3、4 章的改造风险。
3. **run 回放视图**：run-journal 已是现成事实流，写一个离线 reducer→时间线 JSON（run 状态、steer、压缩点、工具调用、token 曲线），供 web UI 或脚本查看；对齐 Codex「热路径只写原始事件，离线再解释」。
4. **usage 落 journal**：token 曲线进回放，成本可观测、熔断有依据。
5. **停滞检测**：给流式请求加空闲超时（Codex 300s，本项目可 120s）+ 对应 e2e 用例（fake stream 挂起）。
6. **诊断脚本**：类比 `codex doctor`，把「端口/凭证/数据目录/数据文件一致性」检查写成一个脚本，出机器可读报告。**→ 已落地（2026-10-11）**：`scripts/doctor.mjs`（`npm run doctor`；人类可读 + `--json` 机器可读，有 fail 退出码 1，只读无副作用），检查面扩至 Node/依赖/.env 与飞书凭证/数据目录可写/核心数据文件解析与 run-journal 尾部/端口/claude CLI/执行后端（docker/podman fail-closed）/MCP 命令可解析；设计见 `specs/2026-10-11-doctor-script-design.md`。

---

## 14. 落地路线图

### P0（1-2 周：低风险高收益，直击三个弱项）

| # | 事项 | 触及模块 | 对应维度 |
|---|------|---------|---------|
| 1 | token 预算中心（bytes/4、窗口 90%、usage 落 journal） | `src/capabilities/context-budget.js`（新）、`conv-compact.logic.js`、`run-openai.js` | 长任务/上下文 |
| 2 | 压缩升级：token+条数双触发、四要素摘要、固定前缀、保留预算 | `conv-compact.logic.js`、`run-openai.js` | 长任务/上下文 |
| 3 | 发送前 normalize（配对修复泛化、孤立清理、中间截断统一） | `src/capabilities/context-normalize.js`（新）、`run-openai.logic.js` | 上下文 |
| 4 | 模型流重试 + 空闲超时 | `agent-loop.js`/model 层 | 长任务 |
| 5 | CI 门禁（test+e2e 子集） | `.github/workflows/` | 测试 |

> **实施状态（2026-10-10）**：P0-①、P0-② 已落地——预算中心为 `src/capabilities/context-budget.logic.js`（`.logic.js` 命名对齐仓库惯例），压缩双触发 + 四要素摘要 + token 感知保留窗口 + `usage`/`compaction` journal 事件，spec 见 `docs/superpowers/specs/2026-10-10-context-budget-and-compaction-v2-design.md`；P0-② 的「摘要固定前缀」未做（system 段已有「## 历史摘要」标识，不重复加）。
>
> **实施状态（2026-10-11）**：P0-③ 已落地——发送前 normalize 为 `src/capabilities/context-normalize.logic.js`（配对就近化 + 脱档结果前拉 + 孤立清理不再只管头部 + 剪空 + 单条中间截断收口 `clipMiddle`）；`repairDanglingToolCalls`/`dropLeadingOrphans` 两处旧实现迁移删除；接线在 `run-openai.js`（载入时合成落盘 + 构建请求前幂等终检），spec 见 `docs/superpowers/specs/2026-10-11-send-time-context-normalize-design.md`；§4 落地清单里的 `stripUnsupported` 未做（openai 路径无附件/图片 part、无模型能力源，挂起）。
>
> **实施状态（2026-10-11，P0 收官）**：P0-④ 已落地——模型流重试 + 空闲超时为 `src/providers/model-retry.logic.js`（决策：白名单可重试判定、指数退避 2s 起步/60s 封顶、5 次、120s 空闲判死）+ `agent-loop.js#runModelStep`（执行：同 convo 重建请求、per-call abort、reasoning 增量当心跳、已产出不重试）；入口 `hooks.onRetry` → `model_retry` journal + 活动行；e2e 新增挂起流用例 `tests/e2e-openai-retry.mjs`；spec 见 `docs/superpowers/specs/2026-10-11-model-stream-retry-and-idle-timeout-design.md`。P0-⑤ 已落地——常规 CI `.github/workflows/ci.yml`（`npm test` 全量 + e2e 无浏览器子集 `openai-resume`/`openai-retry`，push 与 PR 触发）；lint 未做（仓库无 lint 工具链，留 P1）；spec 见 `docs/superpowers/specs/2026-10-11-ci-gate-design.md`。
>
> **实施状态（2026-10-11，P1 加厚）**：P0-⑤ 的两处留白已补齐——①**lint 门禁**：新增 `oxlint@^1.87.0` + `.oxlintrc.json`（33 条正确性规则显式提 error、存量 ~109 条警告不拦）+ `npm run lint`，进 CI 独立 job；首跑即抓出真 bug（`agent-session.js` const 重赋值，任务覆盖模型路径一跑就 TypeError），共 13 处实锤修复/行内豁免；②**e2e 浏览器组**：CI 新增 `e2e-browser` job（`npx playwright install --with-deps chromium` + `npm run test:e2e -- '!openai' '!one-window'`，12/12 本地绿）；`run-e2e.mjs` 过滤器新增 `!` 排除语法；`one-window` 因存量前端 WIP 移除 `.conv-load-more` 暂排除（待前端更新后摘除）。spec 见 `docs/superpowers/specs/2026-10-11-ci-hardening-design.md`。

### P1（2-4 周：能力补齐）

| # | 事项 | 触及模块 | 对应维度 |
|---|------|---------|---------|
| 6 | 命令会话管理器（exec_command/write_stdin/头尾缓冲/上限） | `src/providers/exec-sessions.js`（新） | 长命令 |
| 7 | AgentHandle 注册表 + `send_message`/`wait`/`list_agents` + 状态机落 journal | `src/capabilities/agent-registry.js`（新）、`subagent.logic.js`、`workflow.logic.js` | 多 Agent |
| 8 | 角色降权表（explorer/worker 显式化）+ per-agent 预算 | `agent-roles.js`（新）、`tool-policy.logic.js` | 多 Agent/权限 |
| 9 | follow-up 队列落盘 + plan 工具持久化 | `conv-inbox.js`、`runs.js` | 长任务 |
| 10 | steer 抢占当前流（openai） | `run-openai.js`、`runs.js` | 运行干预 |
| 11 | 工具计划（exposure 分级 + 条件装配收敛） | 新 `buildToolPlan` | 工具加载 |
| 12 | 请求快照测试 + run 回放 reducer | tests/、scripts/ | 可观测 |

> **实施状态（2026-10-11）**：P1-12 已落地——①**发送面快照** `src/entrypoints/web/run-openai.snapshot.test.js`（三个场景：多步工具循环 / 脏历史 normalize / 压缩触发；快照 `src/entrypoints/web/__snapshots__/run-openai-requests.json`，`UPDATE_SNAPSHOTS=1` 重录）锁「每次模型调用收到的 messages + 工具名集合」；②**回放 reducer** `src/store/run-replay.logic.js`(+test) 归约 journal → 时间线（状态/steer/压缩点/重试/审批/token 曲线），CLI `scripts/replay-run.mjs`（`npm run replay:run -- --run-id <id> [--data-dir <path>] [--json]`）。线格式（wire）快照**未做**：组装层才是 P0 改造的风险面，wire 由 adapter 单测 + e2e 行为断言覆盖（理由见 spec「非目标」）；spec 见 `docs/superpowers/specs/2026-10-11-request-snapshot-and-run-replay-design.md`。
>
> **实施状态（2026-10-11）**：P1-④（表中 #9）已落地——①**follow-up 队列落盘**：盘格式 `src/store/conv-followups.js`（`conv-followups.json`；enqueue 按 id 幂等 / cancel / take 三迁移，no-op 不写盘），写方是 `runs.js` 的 `registerFollowUpSink`（接线 `run-durability.js`，写失败吞错留日志），读方是启动恢复 `conv-inbox.js#restoreFollowUpInbox`（hydrate 后对**空闲** conv 补排空，覆盖「run 已终结但队列未排空就崩」窗口；有 running run 的交给终结口；`server.js` 在 `startConvInbox()` 后调用）；②**plan 持久化 + 重注入**：`src/store/conv-todos.js`（`conv-todos.json`，存 TodoWrite 最近快照，单清单 50 项 / 300 conv 上限），`runs.js#registerRunTodosSink`/`hydrateRunTodos`；起跑（含续跑/排空）时 run-openai 在 system 尾部、run-claude 在 `systemPrompt.append` 尾部追加 `renderPlanSection` 渲染的任务清单——压缩/重启后模型不失忆。**不新增 `update_plan` 工具**：Codex 的 plan 语义由既有 TodoWrite + 跨压缩重注入承担。快照新增 s4 锁注入形态；spec 见 `docs/superpowers/specs/2026-10-11-followup-persistence-and-plan-design.md`。
>
> **实施状态（2026-10-11）**：表中 #10（steer 抢占当前流）已落地——openai 从「排队等 run 终结」升级为**步边界 steer**：起跑/续跑置 `capabilities.steer=true` + `steerMode='step'`（`/send`、`/start` busy 路由、飞书注入统一走持有区；follow-up 队列能力保留给无 steer 的 provider，P1-9 落盘/恢复继续服务存量）。`agent-loop` 新增两个 hooks：`takeSteerMessages()`（每个步边界取走 `run.heldMsgs` 并进 convo、走检查点落盘；最终答复边界也注入——已有插话则不结束 run，预算耗尽则留持有区）与 `shouldPreempt()`（本轮 attempt **尚无可见产出**时到达即抢占切断当前模型请求、同一步号重来；250ms 轻量巡检兜底静默思考期；已产出等本轮结束再注入，不产生半截输出）。`/msg/now` 对 step 模式回执 `ok:true`（到达即已请求抢占）。快照新增 s5 锁注入后的发送面；spec 见 `docs/superpowers/specs/2026-10-11-openai-step-steer-design.md`。
>
> **实施状态（2026-10-16）**：表中 #7（AgentHandle 注册表 + send_message/wait_agent/list_agents + 状态机落 journal）已落地——新增 `capabilities/agent-registry{,.logic}.js`（状态机/命名与寻址/journal 归约/文案纯函数 + per-run 句柄运行时，注入式 `runTurn`）；`Task` 增 `background:true`（后台派发 → 立即返回 `agent_id`），`send_message`（空闲起新一轮 / 运行中入邮箱、当前轮结束自动接续）、`wait_agent`（默认 30s，超时如实回「仍在运行」并打心跳）、`interrupt_agent`（只切这一份，历史保留）、`list_agents` 四个工具在 openai 路径装配（逐个独立开关；关掉 `send_message` = 后台派发一并停用）；状态迁移写 `agent_status` journal 事件，回放 reducer 增 `agents` 车道；run 收尾 `settleAll`（60s）→ `finally` `interruptAll`。**Claude 路径不登记**（SDK 原生 Task 无句柄）；角色降权表与 per-agent 预算仍属 #8。spec 见 `docs/superpowers/specs/2026-10-16-agent-registry-and-handles-design.md`。
>
> **实施状态（2026-10-11）**：表中 #6（命令会话管理器）已落地——新增 `src/providers/exec-sessions.logic.js`（缓冲/夹取/文案纯函数）+ `exec-sessions.js`（spawn 登记表/`terminateAll`）；工具面 `exec_command`/`write_stdin`/`list_processes`/`kill_process` 在 `run-openai.js` 装配（辅助通道白名单挑选工具，不受影响），yield 默认 10s、单次读取 ≤ 8KB、头 16K+尾 112K 双保留、per-run 上限 8 会话；run 结束/停止 `terminateAll`（finally + abort 双保险）不留孤儿；策略表新增 `session` 类、`exec_command` 并入 `EXEC_TOOLS`，`write_stdin` 危险输入降级 ask；`killTree` 收编进 `exec-backends.js` 共享。快照 s1–s5 随装配重录（人工核对：仅 +4 工具名 + system 片段）；spec 见 `docs/superpowers/specs/2026-10-11-exec-sessions-design.md`。

### P2（按需）

- fork（从第 N 条消息重开）；工具检索（工具量增长时）；AGENTS.md 兼容 + hooks 事件表；Claude 路径 Bash 容器化 + PreToolUse 策略钩子；guardian 式独立评审；Code-Mode-lite（不建议近期）。

---

## 附：本项目已有优势（不要改坏）

- **运行干预链路**（steer 持有/撤回/立即打断、follow-up、看门狗、飞书补充）比多数同类项目完整，且可撤回设计比 Codex 的纯 steer 更细。
- **崩溃对账**（run-index + pending + classify + 多实例守卫 + 幂等 submissions）设计扎实，方向与 Codex daemon recovery 一致。
- **权限/策略矩阵**（角色门 + 六档 LEVEL_CAPS + fail-closed）与**测试量**（262 单测 + 14 e2e）是资产；本报告的改造都应在此之上叠加，不推翻。
- **业务插件化**与**工作流编排**（auto-dev/bug-patrol/colleague）是 Codex 没有的垂直能力，保持。

---

*报告生成：2026-10-10。Codex 侧为静态阅读结论（commit 806d973）；本项目侧行号基于当前工作区。涉及行号可能随两侧代码演进变化，实施前请以当时代码为准。*
