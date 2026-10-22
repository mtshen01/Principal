# AgentHandle 注册表 + 子代理通信（P1-7）设计

- 日期：2026-10-16
- 状态：已拍板（本文档先于实现提交；决策见 §2 与 §7）
- 关联：`docs/codex-borrowing-analysis.md` §5「多 Agent 协作 ★」可借鉴 P1-①/P1-②、§14 落地路线图 P1 #7；前序：P1-6 命令会话（`specs/2026-10-11-exec-sessions-design.md`，本方案的形态与纪律参照它）、A7 只读子代理（`subagent.logic.js`）、A11 Workflow 编排（`workflow.logic.js`）、T2-P1 journal（`store/run-journal.js`）、P1-12 回放 reducer（`store/run-replay.logic.js`）
- 范围：新增 `src/capabilities/agent-registry.logic.js`（纯函数）、`src/capabilities/agent-registry.js`（per-run 运行时）；改 `src/entrypoints/web/run-openai.js`（装配）、`src/capabilities/tool-policy.logic.js`（`agent` 类扩名）、`src/entrypoints/web/tool-summary.js`（四例文案）、`public/js/tool-list.logic.js`（开关行）、`src/store/run-replay.logic.js`（`agents` 时间线车道）、`src/entrypoints/web/__snapshots__/run-openai-requests.json`（重录）。**Claude 路径不动**（SDK 自带 Task/Agent，无句柄可接管）。
- 不在本次范围：角色降权表与 per-agent 预算（P1-8）、工具计划/exposure 分级（P1-11）、guardian 式独立评审（P2）、跨 run 的 agent 持久化。

---

## 1. 问题

P1-6 之后，**命令会话**已经是「有句柄、有状态、可轮询、可终止」的实体（`exec_command` → `process_id` → `write_stdin` / `kill_process`）。**子代理**仍然是「一次工具调用，用完全忘」：

1. **无状态可查**：`Task`/`Workflow` 跑完只剩活动转录一行与结论文本；本轮派过几个子代理、各自成功还是失败、烧了多少 token、结论摘要是什么，**事后无法检索**（journal 里也没有子代理事实，只有主 run 的事实）。
2. **不能追问**：子代理查完一轮就没了。父模型想「就刚才那个结论再深挖一层」，只能重新派一个子代理——**它上一轮读过的文件、搜过的线索全丢**，等于从零再烧一遍额度。
3. **不能终止**：子代理只有一刀切（整个 run 的 abort）。派出去的调查跑偏了，用户和模型都没有「掐掉它」的手段（Workflow 里一个子任务卡死会把整阶段拖住）。
4. **不能并行**：`Task` 是同步阻塞的，父模型发起后什么都做不了；Workflow 的并行只服务它自己的阶段结构，不能与父模型自己的活并行。

Codex 的对位（§5.2~5.4）：`spawn_agent` 立即返回 `{task_name, nickname}` → `send_message` / `followup_task` → `wait_agent`（带 `timeout_ms`）→ `interrupt_agent` → `list_agents`，状态机 `AgentStatus{PendingInit, Running, Interrupted, Completed, Errored, Shutdown, NotFound}` 由事件流归约。

## 2. 拍板记录（本次决策）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **`Task` 增加可选 `background: true`**：后台派发 → 立即返回 `agent_id`，父模型可继续干活，结论经 `wait_agent`/`list_agents` 取回。缺省 `false` = 现有阻塞语义**逐字不变** | 没有后台模式，`wait_agent`/`interrupt_agent` 无事可做，P1-7 会退化成「只有 list 有实义」。缺省关 = 既有行为与快照除了「多了工具名」外零变化 |
| D2 | **`send_message` 一律不阻塞**：agent 空闲 → 起新一轮；agent 运行中 → 入邮箱、当前轮结束后自动接续。结论统一靠 `wait_agent` 取 | 与 D1 同一套语义（父模型不被阻塞）；Codex 的 QueueOnly/TriggerTurn 两个语义在本项目合流为「一定会被执行」，不引入「入队了但永不触发」的悬空状态 |
| D3 | **句柄生命周期绑定 run**：run 收尾前 `settleAll`（默认等 60s）→ 仍在跑的一律 abort 并在活动行如实告知；用户 abort → 立即 `interruptAll`。**不做跨 run 恢复** | 与 `feishu-ask` 委托注册表同纪律（绑定 run 生命周期，落盘只会制造无人认领的悬挂物）；子代理的半截推理没有续跑价值，重派更便宜 |
| D4 | **spawn 复用 `Task`**，不新增 `spawn_agent` 工具 | 工具面越小越好；`Task` 的语义本来就等于「派一个只读子代理」，加一个布尔参数即可覆盖 Codex 的 `spawn_agent`（含 `fork_turns` 的缺省语义 = 不给历史） |
| D5 | 工具名沿用 **Codex V2 拼写**：`send_message` / `wait_agent` / `interrupt_agent` / `list_agents` | 与 P1-6 的 `exec_command`/`write_stdin` 同一考虑：模型训练语料对这套形态最熟；报告里简写为 `wait`，取 Codex V2 的 `wait_agent` 以免与「等同事回复」同形混淆 |
| D6 | 四个新工具归 **`agent` 类**（与 `Task` 同径 → 放行，其内部工具逐个走审批）；`Workflow` 仍**不入表**（保持默认 ask） | `send_message` 最多拉起 1 个子代理（= Task 的量级），不是 Workflow 那种「一轮十几个」；为它弹审批是纯噪音。`Workflow` 的额度闸维持原判 |
| D7 | **并发闸只作用于后台发起**（`background` spawn + `send_message`），上限 4（对齐 Codex V2 每 session 并发 4）；阻塞式 `Task`/`Workflow` 不设闸 | 阻塞式是父模型自己在等，并发由编排自身上限约束（1 或 3），再设闸只会误伤 Workflow 的第 4 个阶段 |
| D8 | 邮箱上限 8 条（超限拒绝并提示）；`wait_agent` 夹取 1s–300s（默认 30s） | Codex 默认 30s 可对齐；上限从 3600s 收到 300s：等待期间父模型的一步是被占住的（run 看门狗靠心跳续命），等一小时不是这个工具的用法 |
| D9 | 子代理结论仍 clip 8000 字符；`list_agents` 里每条摘要 clip 60 字符 | 8000 是既有口径（A7），不在本次调整；列表是索引，不是内容 |
| D10 | 状态机事件写 journal（新事件类型 `agent_status`），回放 reducer 增 `agents` 车道；**journal 只用于回放/排障，不用于恢复** | 报告要求「状态转换写入 run-journal，对账时能重建」；重建能力落在**纯函数 reducer** 上（`reduceAgentEvents`，可单测、可用于离线回放），不引入启动期恢复路径 |

## 3. 数据模型

```
AgentHandle = {
  id:         'a1'                  // run 内短序号（寻址主键）
  name:       '/root/支付模块审查-1'  // 层级命名（可读、可寻址；父当前恒为 /root）
  provider:   'openai-subagent' | 'workflow-step'
  role:       'explorer'            // 本迭代只有只读探查一个角色（P1-8 再扩 worker/default）
  label:      '子任务 2「支付回调」'   // 活动转录前缀（沿用现有文案口径）
  status:     'pending' | 'running' | 'completed' | 'errored' | 'interrupted'
  createdAt / startedAt / endedAt / turns / waitingMs
  mailbox:    [{ at, text }]        // 运行中追加的要求（最多 8 条）
  usage:      { inputTokens, outputTokens }   // 该 agent 所有轮的累计（**不进**主会话上下文口径）
  summary:    string                // 最后一轮结论（clip 8000）
  error:      string|null
  history:    Array                 // 该 agent 自己的消息历史（**不含** system），续轮据此接续
  controller: AbortController       // 每 agent 一个，派生自 run 的（父 abort → 子 abort）
}
```

不变式：

1. **终态不可复活**：`completed/errored/interrupted` 是终态；`send_message` 起新一轮时状态回到 `running`，但那是**新的一轮**（`turns += 1`），旧轮的终态事实已在 journal 里。
2. **history 不含 system**：system 每轮重建（工作目录/角色说明随 run 变化），与主会话同纪律。
3. **角色只读**：agent 的可用工具集仍是 `pickReadonlyToolDefs` 的 6 件套，**不含 Task/Workflow/send_message**（天然禁递归、禁嵌套编排）。

## 4. 设计

### 4.1 纯函数层（`capabilities/agent-registry.logic.js`，零 IO）

- 状态机：`AGENT_STATUSES` / `isTerminal(status)` / `canTransition(from, to)`（非法迁移抛错或返回原状态，二者取「显式失败」——迁移是代码 bug，不静默）。
- 命名与寻址：`nextAgentId(state)`（`a1, a2…`）、`slugifyAgentLabel(label)`、`buildAgentName(state, label)`（`/root/<slug>-<n>`）、`selectAgent(state, ref)`（先 id 后 name，未命中返回 null）。
- 归约（**恢复/回放用**）：`createAgentState()` / `reduceAgentEvents(events)` → `{agents, seq}`；与运行时同源的 `applyAgentEvent(state, ev)`，保证「journal 里的事实」与「内存里的状态」是同一个 reducer 算出来的。
- 文案（工具结果与活动行**只此一份**）：`formatSpawnAck` / `formatSendAck` / `formatWaitResult` / `formatWaitTimeout` / `formatInterruptAck` / `formatUnknownAgent` / `formatMailboxFull` / `renderAgentList` / `formatAgentLine`。
- 参数夹取：`clampWaitMs(v)`（默认 30s，1s–300s）、`MAILBOX_MAX = 8`、`AGENT_MAX_BACKGROUND = 4`、`SUMMARY_CLIP = 8000`、`LIST_SUMMARY_CLIP = 60`。
- 工具定义（zod）：`send_message` / `wait_agent` / `interrupt_agent` / `list_agents`（与本仓其它能力层工具同范式：schema 放 `.logic.js`，执行在运行时）。

### 4.2 运行时（`capabilities/agent-registry.js`，per-run，注入式）

```js
const agents = createAgentRegistry({
  emit,        // (type, data) => void           → run-openai 里接 emitRunEvent(run, …)
  activity,    // (line) => void                → runActivity
  pulse,       // () => void                    → runPulse（等待期间防看门狗误杀）
  runTurn,     // async ({ agent, messages, text, signal }) => {text, history, inputTokens, outputTokens}
  now,         // 可注入（测试）
});
```

API：

- `spawn({ label, prompt, provider, role, background, goal })` → handle。**运行由本模块驱动**：`background=false` 时返回已注册的 handle 且 `.settled` 即该轮 promise（调用方 `await` = 现有阻塞语义）；`background=true` 时立即返回（未 await 的 rejection 已挂兜底 catch，绝不留未处理 rejection）。
- `send(agentId, text)` → `{ok, mode:'started'|'queued', agent}`；空闲起轮、运行中入邮箱；超并发闸/邮箱满/未知 id 分别给明确文案。
- `wait(agentId, { timeoutMs })` → `{agent, timedOut}`；等待期间每 1s `pulse()`，按信号可中断；agent 已终态立即返回。
- `interrupt(agentId)` → `{agent, changed}`；运行中 → abort 该 agent 的 controller（该轮以 `interrupted` 收尾）；空闲 → 如实回「当前没有在跑」（不改状态）。
- `list()` / `get(id)`。
- `settleAll({ timeoutMs = 60_000 })` → 等所有后台 agent 收尾；超时者 abort 并返回 `{aborted: n}`（调用方据此写活动行）。
- `interruptAll()` → run 收尾/用户中止时的兜底；幂等。
- `executeTool(name, input)` + `toolDefs`：四个工具的执行体（`Task` 仍在 run-openai 的 dispatch 里走 `spawn`，本模块不接管 `Task` 的 schema）。

**每轮的驱动**（`runTurn` 由 run-openai 注入）：

1. `status: running` → `emit('agent_status', {agentId, name, role, provider, status, turns, label})`；活动行 `🔍 <label>：…`（沿用现有前缀）。
2. 调 `runTurn({ agent, messages, text, signal })` —— `messages` 是本轮完整序列（不含 system；续轮已含该 agent 自己的历史），执行体拼 system 后跑一次子代理 agent-loop（同凭证/模型/强度/预算，审批复用主 run 策略门）。
3. 成功 → `completed` + `summary` + `history` 接续 + usage 累计；失败 → `errored` + `error`（abort 语义 → `interrupted`）。
4. 终态后若邮箱非空 → 自动接续一轮（D2）；`settleAll` 只看「当前是否还有在跑的轮」。

### 4.3 接线（`entrypoints/web/run-openai.js`）

- 现有 `runReadonlySubagent(prompt, {label, goal})` 拆成：`callSubagentTurn({agent, text, signal})`（真正的 provider 调用，含 per-agent controller 与重试活动行）→ 注入 registry 的 `runTurn`。
- `Task` 执行体：`label = 子代理`，`background` 透传；阻塞分支 `await handle.settled` 后返回 `clipText(text, 8000)`（**返回值形状不变**）。
- `Workflow` 执行体：`runWorkflowPlan` 的 `runTask` 改为 `spawn({provider:'workflow-step', label:'子任务 N「标题」'})`，保持阻塞（编排仍是同步的）。
- 新增四个工具的 dispatch 分支 + `disabledTools` 处理：`list_agents`/`wait_agent`/`interrupt_agent` 各自独立开关；**`send_message` 关掉时同时关掉后台模式**（`Task({background:true})` 降级为同步执行，活动行说明原因）——后台代理没有取回手段就是「烧钱丢结论」。
- 收尾：`handle.done.then(...)` 里 `await agents.settleAll(...)` 后再 `finishRun`；`.finally` 里 `agents.interruptAll()`（与 `sessions.terminateAll()` 并排）；`run.abortController.signal` 的 abort 监听里 `interruptAll()`。
- journal：`emitRunEvent(run, 'agent_status', { agentId, name, provider, role, status, turns, ms, inputTokens, outputTokens, summaryChars, error? })`（文本字段过 `truncateForJournal`）。

### 4.4 周边同步

- `tool-policy.logic.js`：`AGENT_TOOLS` 增四个名字（D6）——`classifyTool` 返回 `agent`，走既有 `caps.other === 'deny' ? deny : allow` 分支。
- `tool-summary.js`：四例文案（`给子代理 a2 发消息：…` / `等待子代理 a2 …` / `中断子代理 a2` / `列出子代理`）。
- `public/js/tool-list.logic.js`：`OPENAI_BUILTIN_TOOLS` 增四行（`send_message` 行描述里写明「关掉它后台派发一并停用」）；`Task` 行的描述补一句「可选后台模式」。
- `run-replay.logic.js`：新 `agents` 车道（`spawn/running/completed/errored/interrupted` 归约成 `[{at, agentId, name, status}]`），`formatRunTimeline` 增行；未知类型白名单机制不变。
- 快照：`run-openai.snapshot.test.js` 的 s1–s5 重录（人工核对：`tools` 数组**只增不改**，system 片段不变）。

### 4.5 system 提示词

不新增授权说明段（与 `Workflow` 不同：这四个工具没有额度放大器性质，工具描述已写清用法）。`Task` 的描述补一句后台模式与取回方式——模型得知道 `background` 存在。

## 5. 测试

- `agent-registry.logic.test.js`：状态迁移合法性（含终态不可复活）、id/名字生成与去重、`selectAgent` 三种寻址、`reduceAgentEvents` 与运行时同源（同一串事件 → 同一状态）、各文案函数、`clampWaitMs` 夹取、四个工具 schema 正反例。
- `agent-registry.test.js`（注入假 `runTurn`，零真实模型）：
  - 阻塞 spawn：返回结论、状态 `completed`、journal 事件序列（`running`→`completed`）恰一次；
  - 后台 spawn：立即返回、`list` 可见 `running`、`wait` 拿到结论；**未消费的 rejection 不炸进程**；
  - `send` 到空闲 → 起新一轮（`turns=2`，history 接续，第二轮 prompt 里能看到 agent 自己的历史）；
  - `send` 到运行中 → `queued`，当前轮结束后**自动接续**且结论更新；
  - `wait` 超时 → `timedOut=true` 且如实报「仍在运行」；期间 `pulse` 被调用（心跳）；
  - `interrupt` 运行中 → 该轮以 `interrupted` 收尾、后续 `wait` 立即返回；空闲时 `changed=false`；
  - 并发闸：第 5 个后台发起被拒（文案含上限）；邮箱满 8 条被拒；
  - `settleAll` 正常等待 / 超时 abort 并返回条数；`interruptAll` 幂等；
  - 未知 id 的四个工具都给可读文案，不抛。
- `run-openai` 侧：快照 s1–s5 重录 + 一条集成用例（假 provider：`Task({background:true})` → `wait_agent` 取回结论），确保接线（`runTurn` 注入、`settleAll` 收尾）真的生效。
- 全量 `npm test` + `npm run lint` + `npm run test:e2e -- openai-resume openai-retry`（CI 子集）。

## 6. 回退

删四个工具的 `localDefs`/dispatch 分支 + `agents` 接线即回到今日行为（`Task`/`Workflow` 逐字不变）；`agent_status` 是新增事件类型，reducer 白名单外不炸回放。

## 7. 已知边界（如实记录）

1. **Claude 路径不登记**（D4 的必然结果）：SDK 原生 Task/Agent 没有句柄，我们只有 `task_started/task_progress/task_notification` 系统事件（可用于只读登记，留作后续）；本迭代 `list_agents` 在 Claude 路径下**不存在**（工具只在 openai 路径装配）。
2. **`interrupt` 掐不断已开始执行的工具**：abort 作用于模型请求与该轮循环；子代理正在跑的 Read/Bash 会自然结束（与主 run 的 abort 语义一致）。
3. **后台 agent 与 run 收尾有竞态**：`settleAll` 60s 内没结束就 abort（结论丢失，活动行如实说明）。这是有意的权衡：不能让一个后台子代理无限推迟主 run 的收尾。
4. **状态机只在内存 + journal**：进程崩溃后本轮 agent 事实只存在于 journal（可回放），不重建（D10、D3）。
5. **usage 不并入主会话上下文口径**：子代理的 token 计入 agent 自己的 `usage`，不进主 run 的 `usage`（顶栏「上下文 xx%」表示的仍是主会话窗口）。
