# 运行中发送默认排队（queue-first）+ 队列项「立即发送」（steer-now）· 设计

- 日期：2026-10-16
- 状态：已实现（与本文档一并留工作区）
- 需求来源（用户原话）：「如果当前会话正在执行，再发送消息，则默认不执行，需要等当前会话完全执行完成后，继续下一个任务，然后等待的队列任务支持立即发送」+ OpenCode 排队卡片截图（输入框上方的排队项，带「引导 / ×」两个动作）。
- 关联：`docs/superpowers/specs/2026-10-11-openai-step-steer-design.md`（step steer 能力）、`2026-10-11-followup-persistence-and-plan-design.md`（follow-up 落盘/恢复/排空）、T2-P4 busy inbox。
- 范围：`src/store/runs.js`、`src/entrypoints/web/routes-run.js`、`conv-inbox.js`、`conv-notify.js`（不改）、`run-claude.js` / `run-openai.js`（能力位）、`server.js`（路由）；前端 `public/index.html`、`app.css`、新增 `public/js/queue-strip.js`(+logic+test)、`chat.js`；e2e 两个文件。

## 1. 背景与问题

现状 busy inbox（T2-P4 → P1-10）**默认把运行中收到的消息 steer 进当前 run**：

- Claude：`heldMsgs` 持有区，本轮 `result` 时 flush 进 SDK 输入流，任务中途多跑一轮；
- openai：步边界注入 + 无可见产出时抢占；
- 前端：消息直接进转录流成为「排队气泡」，带「撤回 / 立即生效」两个按钮。

用户拍板的对齐对象是 OpenCode 的 inbox 语义（V2 API：`inbox/{id}/steer` = 「Change a queued inbox item to steer delivery and wake session execution」）：

1. **默认排队、不改动当前任务**：消息先入队；当前任务完整执行完成后，队列自动排空、作为**下一个任务**继续跑（「默认不执行、等完全执行完成后继续下一个任务」）；
2. **按需插话**：每条排队项支持「立即发送」，点了才 steer 进当前任务（对齐截图里的「引导」）；
3. **UI**：排队项显示在**输入框上方**的紧凑卡片条（消息文本 + 「立即发送」+ 「×」），未发送前**不进入消息转录流**（对齐截图）。

## 2. 目标与非目标

**目标**

1. **默认路由改排队**：`/api/run/start` 撞 busy conv、`/api/run/send`、以及所有 busy inbox 路由，默认落 follow-up 队列（不再 steer 进当前 run）；两 provider 一致。
2. **立即发送（steer-now）**：新动作把某条排队项**转换**为当前 run 的持有消息并立即投递（Claude：flush + interrupt 当前轮；openai step：步边界注入 / 无产出抢占），消息随即进入任务。
3. **自动续接**：当前 run 终结（正常/异常/停止/看门狗/额度阻塞）后，队列由既有 `conv-inbox` 排空机制起下一轮——本轮不改语义，只补「排空记录带文本」供前端上屏。
4. **输入框上方队列卡片条（queue strip）**：多卡按序堆叠；「立即发送」= steer-now，「×」= 撤回；排队项未进入任务前不进转录。
5. **投递时上屏**：排队项被消费（steer 或排空起跑）时，作为普通用户消息插入转录流（Claude steer 场景仍切段；排空场景在助手占位气泡之前插入）。
6. **不丢消息**：steer-now 的转换带前置校验 + 同步回滚；step 注入/收尾轮未消费的持有消息在终结时**回到队列**（而不是标 unsent 丢弃），随排空进入下一轮。

**非目标**

- 不改飞书注入语义（`conv-notify#injectToConv` 仍 steer-first；bot 侧没有队列 UI，「补充内容」即时生效的价值不变）。后续若要统一另开 spec。
- 不做跨会话队列、队列排序（拖拽）、编辑重发（OpenCode 的拖拽手势不抄）。
- 不改「同会话永不并发两个 run」不变量；不改 follow-up 落盘/恢复机制（P1-9 原样复用）。
- 不改权限审批 / 停止按钮 / 看门狗行为。

## 3. 拍板记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 默认落地 | `queueIntoBusyConv` / `handleRunSend` 按能力位**优先 followUp**（排队）；`steer` 只剩显式动作（`/msg/now`）。两 provider 的 run 都补 `capabilities.followUp = true`（`steer` / `steerMode` 保留）。 |
| 2 | 「立即发送」语义 | 把 follow-up 项**转换**为当前 run 的持有消息再走既有投递：Claude turn 模式 = `flushHeldMsgs` + `interrupt`（前置要求 `run._input.push` 可用，否则拒绝且不改状态）；openai step 模式 = 放回持有区即已请求抢占，回执 ok（与 P1-10 `/msg/now` 同口径）。 |
| 3 | 转换的标识 | **复用原 follow-up id**（`holdMsg` 支持显式 id）：consumed 事件、撤回、对账全链路 id 不变，前端卡片不需要 id 映射。 |
| 4 | 转换失败回滚 | turn 模式投递前先校验输入流；`flushHeldMsgs` 返回空（流已关闭）→ 撤销持有、把原排队项**按原位置**放回队列，响应 `ok:false`（用户可稍后重试，任务照常收尾排空）。 |
| 5 | 未消费兜底 | 终结时 `heldMsgs` 里 `origin:'queue'` 的消息**回到队列**（按 `at` 顺序插入，id 不变），随同一终结 tick 的排空进入下一轮；**不进** `unsentIds/unsentMsgs`（避免 conv-notify 双投递）。非队列来源（飞书插话）维持原 unsent 语义。 |
| 6 | 队列卡片位置 | 输入框上方（`.composer-box` 内、`#prompt` 之前）；未投递前**不进转录**，投递（consumed / 排空接流）时插入为用户消息并落 `msgId` 戳用于幂等。 |
| 7 | 列表接口 | 新增 `GET /api/run/queue?convId=`：返回 `{ runId, items:[{id,text,at,source,attachments,mode:'queue'|'steer'}] }`（服务端为唯一真相；前端卡片状态=服务端列表 + 本地文本缓存）。 |
| 8 | 对账策略 | 打开会话 / attach replay / `queue`·`consumed`·`follow_up`·`follow_up_cancelled`·`steer_requeued`·`done` 事件 / 轮询 followUps → 拉 `/api/run/queue` 合并：本地有、服务端无且**早于本次拉取**的项视为已投递 → 上屏（msgId 戳幂等去重）。刚入队未回落的项用时间戳防误判。 |
| 9 | 排空记录带文本 | `markFollowUpStarted` 记录 `texts`；`/api/run/pending` 的 followUps 透传——离线期间被排空的消息重开页面也能上屏。 |
| 10 | 卡片条与旧 UI | 旧的转录内「排队气泡」（q-actions / `.q-actions` / `applyQueuedDecor` / `withdrawQueuedMsg` / `effectNowQueuedMsg` / `steer()` 插话路径）**删除**；遗留 localStorage 里的 queued 标记按普通消息渲染并由对账清理。 |
| 11 | 排空轮 mode 快照 | 对齐 openai 分支：Claude 的排空轮也取「排空时刻原 run 的最新 `mode`」优先、回落排队快照（用户在排队期间改过权限档位时不能丢）。 |
| 12 | 停止/异常后的队列 | 维持既有「终结口排空」语义（停止、异常同样触发排空）——与用户「等当前会话完全执行完成后继续下一个任务」一致；不做「停止即冻结队列」。 |

## 4. 设计

### 4.1 服务端

**runs.js**

- `holdMsg(run, text, attachments, opts)`：新增 `opts.id`（复用 follow-up id）与 `opts.origin:'queue'`、`opts.requeue`（原排队项快照，兜底回队用）；新增 `broadcastQueue(run)` 统一 fanout `queue {held, queued}`。
- 新增 `steerQueuedNow(convId, msgId, run)`（原子化转换+投递）：
  1. 队列里找不到（已消费/已撤回）→ `{ok:false, code:'gone'}`；
  2. turn 模式且 `run._input?.push` 不可用 → `{ok:false, code:'not_ready'}`（**先校验后出队**）；
  3. 出队（镜像 `cancel` op）→ `holdMsg`（id 复用、origin/requeue 带上）；
  4. turn 模式：`flushHeldMsgs` 为空 → 回滚（`withdrawHeldMsg` + 按原位置回队 + 镜像 `enqueue`）→ `{ok:false, code:'input_closed'}`；否则 `cancelPendingAsks` + `interrupt` + `runPulse`；
  5. step 模式：直接 `{ok:true}`（抢占/步边界注入照旧）。
- `unsentField(run)`：拆分 `origin:'queue'` 的未消费项 → `requeueItem(convId, item)`（按 `at` 插入，id 不变；镜像 `enqueue`）并 `fanout('steer_requeued',{ids})`；其余走原 unsent 路径（`steer_unsent` + done.unsent），无 unsent 时不再广播空事件。
- `enqueueFollowUp` / `cancelFollowUp`：有运行中 run 时补 `broadcastQueue`（推送形状统一为 `{held, queued}`）。
- `markFollowUpStarted(convId, {runId, ids, texts})`：附带文本（排空上屏用）。

**routes-run.js**

- `queueIntoBusyConv`、`handleRunSend`：路由改 `caps.followUp ? 排队 : (caps.steer ? 持有 : 拒绝)`；响应 `mode:'follow_up'`；`logUserText` 保持（kind 不变，语义仍是「运行中追加」）。
- `handleRunMsgNow`：`{runId, msgId}` → 优先 `steerQueuedNow`；`msgId` 缺省保留旧语义（flush 全部持有 + 打断；step 回执 ok）。
- 新增 `handleRunQueueList(url, res)`：按 `convId` 返回运行中 run 的 `heldMsgs`（mode:'steer'）与 `listFollowUps`（mode:'queue'）；`runId` = 该 conv 当前运行中 run（无则 null）。
- `handleRunPending`：透传 `texts`（`listFollowUpStarts` 已含）。

**conv-inbox.js**

- `drainFollowUps`：`markFollowUpStarted(..., {ids, texts})`；Claude 分支 `mode` 改 `run?.mode || first.mode`（对齐 openai 分支）。

**能力位**

- `run-claude.js`：`run.capabilities.followUp = true`（紧邻 steer 设置）。
- `run-openai.js`：起跑/续跑两处 `run.capabilities.followUp = true`。
- `handleRunStart`：Claude 提前置位处补 `followUp = true`（覆盖判档窗口）。

**server.js**：路由表加 `{ path: '/api/run/queue', method: 'GET', h: (req,res,url) => handleRunQueueList(url, res) }`（排在 `/api/run` 之前）。

### 4.2 前端

**队列卡片条（`public/js/queue-strip.js` + `queue-strip.logic.js`）**

- `createQueueStrip({ root, onSteer, onWithdraw })`：`root` = `#queueStrip`；`render(items, {steeringId})` 重建卡片（文本 + `立即发送`（↑ 图标）+ `×`）；空列表隐藏；`steeringId` 显示「发送中…」并禁用按钮。卡片文本 CSS 两行截断，`title` 原文。
- `mergeQueue(local, server, {fetchStartedAt})`（纯函数，可单测）：返回 `{items, delivered}`——服务端列表为准（补 mode/at）；本地独有且 `at < fetchStartedAt - 缓冲` 的项判定已投递（进 `delivered`）。

**chat.js**

- 状态：`convQueues[convId] = [{id,text,at}]`，持久化到 `conv.meta.queue`（`convSetMeta`；重开页面/离线投递兜底），跨设备视为单用户场景。
- `syncQueue(convId)`：拉 `/api/run/queue` → merge → `delivered` 逐条 `deliverQueueItem`（幂等：消息带 `msgId` 戳）→ 渲染（仅当前会话）。
- `queueSend(job, text, opts)`（替换旧 `steer()`）：`POST /api/run/send` →
  - `ok` → 清输入框 + 卡片入列（含 `convFollowUpPending[convId]=true` 以触发 done 后提前轮询）；`_consumedIds` 竞态兜底；
  - `!ok`（run 恰好结束）→ 降级新一轮：先补用户消息 + `splitSegment` + `restartAsNewRun`。
- `adoptQueuedLaunch(job, d)`（未在本地运行的 race 分支）：撤掉刚建的**用户气泡**（保留助手占位并接管运行中 run 的流），文本进卡片条。
- `deliverQueueItem(convId, {id,text}, {job, split})`：`msgId` 幂等 → 追加用户消息（`recordMessage` 同发）→ 需要时 `splitSegment(job)`；仅当前会话动 DOM。
- SSE：新增 `queue` / `follow_up_cancelled` / `steer_requeued` 监听 → `syncQueue`；`replay` 改为 `syncQueue`（+ 遗留 queued 标记清理）；`consumed` → 卡片命中项 `deliverQueueItem(split: job)`；`done` → `syncQueue` + 处理「发送中」卡片（服务端已无该 id → 上屏）。
- 排空接流（`refreshPending` follows 分支）：先用 `f.texts`/本地卡片在助手占位**之前**插入用户消息并移除卡片，再走原「占位 + attach」。
- `openConv` / `newConversation`：`syncQueue` / 隐藏卡片条。
- 删除：`applyQueuedDecor`、`setMsgQueuedState`、`withdrawQueuedMsg`、`effectNowQueuedMsg`、`steer()`、`addMessage` 里的 q-actions 构建、相关 CSS（`.q-actions` / `.bubble.queued` / `.q-hint`）；`updateComposerRunning` 文案改为「消息将排队，可等待自动执行或立即发送」。

**样式（app.css）**：`.queue-strip`（输入框上方、卡片栈、上边框分隔）、`.queue-card`、`.queue-card-text`、`.qc-btn`（立即发送）、`.qc-x`（×），沿用现有深色 token。

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| steer-now 转换后投递失败 → 消息卡死 | 「先校验后出队」+ flush 空则同步回滚回队；step 模式兜底由终结回队（决策 5）接力 |
| 终结回队与排空竞态（双起 run） | 回队在 `unsentField`（fanout done 之前）完成，排空由同一终结口的 settle 监听器执行——单线程同步链内先后确定 |
| 前端误判「已投递」把新入队项上屏 | merge 用 `fetchStartedAt` 时间窗排除刚落库的项；上屏带 `msgId` 幂等戳 |
| 旧 localStorage 残留 queued 气泡 | 对账统一清理；删除旧交互不做迁移（无服务端对应物） |
| 消息被「停止」后仍自动开下一轮 | 与既有 follow-up 语义一致（队列本就是「等前一轮终结就跑」）；如需冻结另开需求 |
| 回滚 | 还原路由两处「优先 followUp」+ 能力位即可回 steer 默认；前端卡片条独立文件，删接线即回旧 UI |

## 6. 测试策略

- **store 单测**（`src/store/*.test.js`）：`steerQueuedNow` 四态（正常转换 / gone / not_ready 不出队 / flush 空回滚原位置）；`unsentField` 队列来源回队 + id 不变 + 不进 unsent；`markFollowUpStarted` texts。
- **路由单测**（`routes-run.test.js` 更新+新增）：busy send 默认 `follow_up`（Claude + openai）；`/msg/now` 带 msgId 的 turn / step / 回滚分支；`GET /api/run/queue` 形状。
- **conv-inbox 单测**：排空记录带 texts；Claude 分支 mode 取 run 最新值。
- **前端单测**：`queue-strip.logic.test.js`（merge 三态：服务端为准 / 本地独有判投递 / 时间窗防误判）。
- **e2e**：改写 `tests/e2e-follow-up-queue.mjs`（排队卡片出现、转录不变、`立即发送` 经 `/msg/now` + consumed 上屏、排空接流上屏）；`e2e-steer-bubble.mjs` 改为「卡片 → 立即发送 → 切段后流式输出只进助手气泡」。
- **全量回归**：`npm run lint && npm test`；浏览器组 e2e 子集守绿。
