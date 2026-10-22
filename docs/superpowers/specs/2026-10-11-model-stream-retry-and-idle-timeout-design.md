# 模型流重试 + 空闲超时（P0-④）· 设计

- 日期：2026-10-11
- 状态：已实现（本文档与实现一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §3.4 / §14 P0-④；上游工作：P0-①②（`2026-10-10-context-budget-and-compaction-v2-design.md`）、P0-③（`2026-10-11-send-time-context-normalize-design.md`）
- 范围：新建 `providers/model-retry.logic.js`（决策纯函数）；改 `providers/agent-loop.js`（执行：步内重试循环 + 空闲看门狗）、`providers/openai-compat-model.js`（每次调用的中断源合并 + 思考增量当心跳）、`entrypoints/web/run-openai.js`（`onRetry` 接线：journal + 活动行）。Claude 路径不动（重试由 SDK 管）。

## 1. 背景与问题

Codex 把「模型请求失败」当作**循环内层**的一等公民处理：

- `ResponsesStreamRetryState`（`codex-rs/core/src/responses_retry.rs:23-32`）：连接重试初 5s、上限 60s；provider 默认 `stream_max_retries=5`（硬顶 100）、**流空闲 300s 判死**（`model-provider-info`）；
- 重试循环在 `run_turn` 采样层（`core/src/session/turn.rs:1636-1732`）：失败后**从当前历史重建整个请求**（天然幂等，不续半截流），`handle_response_stream_error` 按错误类型决定「可重试/直接抛」——`retry_delay()` 对 `TurnAborted / InvalidRequest / ContextWindowExceeded / QuotaExceeded…` 一律 `None`（不重试），只对瞬时类给指数退避；
- 对用户可见的提示：重试会 `notify_stream_error`（「Reconnecting... n/5」），把「停下喘口气」透明化。

本项目现状（报告 §1/§3 的实测结论）：

1. `agent-loop.js` 循环**完全不重试模型错误**，一步失败直接抛出 → `failRun` → 崩溃对账 `attempt+1`` 续跑整个 run。一次网络抖动 = 用户等一次完整的对账重启（3s 调度 + 从检查点重建请求），代价与收益严重不匹配；
2. **没有空闲超时**：SSE 挂死（连接在、永不吐事件）只能等 run 看门狗 15min 静默判死，长任务被白白拖住；
3. `finishReason=error` 在主循环里判错，同样没有复活机会。

## 2. 目标与非目标

**目标**：

1. **步内重试**：`agent-loop.js` 的每一次模型请求（含强制收尾轮）失败后，按 Codex 口径指数退避重试：默认 **5 次**、起步 **2s**、封顶 **60s**；重试基于同一 `convo` 重建请求（失败尝试（不含）不落账 → 幂等）；
2. **空闲判死**：默认 **120s** 无任何流事件（含首包）判死本次请求，主动中断后按断流同路径重试；思考增量（`reasoning-delta`）也算心跳（适配器透传为 `{type:'reasoning'}`）；
3. **可重试判定白名单式**：只重试明确可复活的（429/408/409/5xx、网络断流、空闲超时、`finishReason=error`）；`4xx`（除 429/408/409）、校验类错误、用户中断一律不试；
4. **已产出不重试**：本步只要向用户输出过文本或工具活动，失败即原样上抛——重发会造成气泡重复段落；
5. **可观测**：`hooks.onRetry` → journal `model_retry` + 活动行「⏳ 模型流中断（网络中断），2 秒后重试（第 1/5 次）」；
6. **旋钮**：环境变量（e2e/自部署用）+ 显式参数（单测用），显式 > env > 默认。

**非目标**：

- **流内续传**（Codex WebSocket 的 `previous_response_id` 增量续传）——本项目是标准 chat.completions SSE，无服务端会话状态，重建请求是唯一口径；
- jitter（Codex 有加抖动防惊群；本项目单用户单请求，无并发对撞场景）；
- 已产出内容的重试（部分文本截断续写）——UX 与实现复杂度都不划算，留 P1+；
- UI 设置页旋钮（暂用 env；等有真实需求再上存储层）；
- 惰性 `finished` 的超时（流结束后 result promise 迟迟不 resolve 的极端场景仍由 run 看门狗兜底）。

## 3. 拍板记录（2026-10-11）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 重试落点 | **agent-loop 步内层**（对齐 Codex 采样层重试），不动 run 级对账——对账仍是崩溃/进程级故障的兜底，两者职责不重叠 |
| 2 | 可重试判定 | **白名单式**：AI SDK `isRetryable` > `statusCode` > 文本模式（408/409/429/5xx、socket/fetch 断流词）；**未知错误默认不重试**（重试也修不好的错误不浪费额度与等待）；`code:'stream_idle'` / `'model_finish_error'` 两类自产错误直接可重试（不依赖文案） |
| 3 | 已产出门槛 | `emitted`（本步转发过 text/tool-call）为真即不重试；失败文本挂 `error.partialText` 由主循环落 `lastText`——保住旧语义「已给用户看到的文字不假装没发生」 |
| 4 | 退避口径 | `initial × 2^(n-1)` 封顶 `maxDelay`；默认 2000ms 起（Codex 5s，本项目桌面场景求快）、5 次（Codex `stream_max_retries` 默认）、封顶 60s（对齐 Codex） |
| 5 | 空闲超时 | 默认 **120s**（Codex 300s；报告建议 120s）无任何流事件判死；判死先 `abort()` 本步请求（新增 per-call 中断源），再走重试路径；`reasoning-delta` 透传为心跳，避免长思考误杀 |
| 6 | 中断优先 | `signal.aborted` 短接一切：不重试、退避等待立即打断（可中断 sleep）→ 外层按既有 aborted 静默收场 |
| 7 | 旋钮口径 | `MODEL_STREAM_IDLE_MS` / `MODEL_STREAM_RETRY_MAX` / `MODEL_STREAM_RETRY_BASE_MS` / `MODEL_STREAM_RETRY_MAX_MS`；显式参数 > env > 默认。e2e 用 env 把空闲压到亚秒级（默认 120s 不可测）；env 未设时行为与常量一致 |
| 8 | 可观测接线 | 主 run：`model_retry` journal（retry/max/delayMs/kind/error 截断）+ 活动行；子代理：只发活动行（带 label 前缀），不写 journal（子代理不是 run 事实流的主体）；重试日志 `logger.warn` 留痕 |
| 9 | finishReason=error 归位 | 判定从主循环搬进重试层（同一条失败路径）；无输出时可重试、已有输出时行为与旧版一致 |
| 10 | 收尾轮适用 | 强制收尾轮走同一包装（`forward:'text'`——工具调用本就该忽略，不产生活动、不算已产出）；收尾轮失败仍 fail-open（沿用旧行为：日志告警、按原状结束） |

## 4. 设计

### 4.1 新模块（`providers/model-retry.logic.js`，零 IO）

| 导出 | 职责 |
|---|---|
| `RETRY_DEFAULTS` | `{ maxRetries:5, initialDelayMs:2000, maxDelayMs:60000, streamIdleMs:120000 }` |
| `resolveRetryOptions(partial, env)` | 显式 > env > 默认；非法值（NaN/负数）回落默认；`maxRetries:0` = 不重试；env 键名见拍板 7 |
| `nextRetryDelayMs(retry, opts)` | 第 retry 次（1-based）重试前等待：`initial×2^(retry-1)` 封顶 `maxDelay` |
| `classifyModelError(error, {aborted})` | → `{retryable, kind}`；kind ∈ `aborted/idle/finish/network/http/api/other` |
| `describeRetryKind(kind)` / `formatRetryDelay(ms)` | 活动行中文文案（「流空闲超时」「2 秒」） |

### 4.2 执行（`providers/agent-loop.js`）

```
runAgentLoop({ ..., retry }, hooks)          // retry 可选；resolveRetryOptions(retry) 一次解析
  for step:
    runModelStep({ modelRun, messages: convo, signal, retry, hooks })
      attempt 循环（1 .. maxRetries+1）：
        attemptAbort = AbortController()      // 空闲判死用（与本步 signal 联动）
        modelRun(convo, { ...opts, signal: attemptAbort.signal })
        消费流：每事件重置空闲计时；text→onText、tool-call→onActivity（forward:all）
        空闲触发 → attemptAbort.abort() + 抛 code:stream_idle
        await finished → finishReason=error → 抛 code:model_finish_error
        失败：classify → 不可重试/已产出/超上限/已中断 → 抛（附 partialText）
              可重试 → logger.warn + hooks.onRetry → 可中断退避 → 下一 attempt（同 convo 重建）
```

- 主循环与强制收尾轮都经 `runModelStep`；`finishReason=error` 检查随之移入；
- `stream` 抛错后不 await 的 `finished` 一律挂兜底 catch（防未处理 rejection；真 adapter 内部同款）；
- 已产出文本经 `error.partialText` 回传主循环落 `lastText`（外层 catch 的 aborted/error 返回都带上）。

### 4.3 模型 adapter（`providers/openai-compat-model.js`）

1. **per-call 中断源**：`modelRun(messages, opts)` 现在认 `opts.signal`，与 provider 级 `abortSignal`（run 的 abortController）合并（`AbortSignal.any`）——空闲判死只断本次请求，不动整个 run；缺任一侧退化为存在的一侧；
2. **思考增量当心跳**：`fullStream` 的 `reasoning-delta`（ai@7 已核字段 `text`）透传为 `{type:'reasoning', text}`；agent-loop 不展示它，但空闲计时器把**任何**流事件当活着——DeepSeek 类思考模型长时间不吐正文时不再被 120s 误杀。

### 4.4 入口接线（`entrypoints/web/run-openai.js`）

```
hooks.onRetry = (info) =>
  emitRunEvent(run, 'model_retry', { retry, max, delayMs, kind, error: truncateForJournal(error) })
  + runActivity(run, `⏳ 模型流中断（${describeRetryKind(kind)}），${formatRetryDelay(delayMs)}后重试（第 n/N 次）`)
子代理 hooks.onRetry = 活动行（`⏳ ${label}：…`），不写 journal
```

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 120s 空闲误杀长思考 | `reasoning-delta` 心跳 + env `MODEL_STREAM_IDLE_MS` 可调；判死有明确活动行与 journal，可复盘 |
| 重试放大计费/重复请求 | 只在「未产出任何用户可见内容」时重试（重复成本可忽略）；上限 5 次；429/5xx 本来就是服务端未出结果 |
| 重试期间用户看不出来 | 每次重试都有活动行（用户可随时「停止」，退避等待被打断） |
| 未知错误不重试导致本可恢复的失败未恢复 | 白名单覆盖了 AI SDK/undici 的可识别瞬态；未命中的错误仍旧上抛给对账续跑兜底（行为不比现状差） |
| 已产出断流无重试 | 这是**有意**取舍（避免重复段落）；用户看到部分文本 + 失败提示，可「继续」 |
| 行为回归 | 失败路径旧测试全保留（`net down` 不重试、finishReason=error 带 partial）；干净路径零变化 |
| 回滚 | `agent-loop.js` 改回直接 `modelRun` + for-await 即可；新逻辑模块纯函数，无存储格式变更、无迁移 |

## 6. 测试策略

- `providers/model-retry.logic.test.js`（新）：默认/显式/env 优先级、非法值回落、`maxRetries:0`；退避序列与封顶；判定矩阵（aborted、两类自产 code、`isRetryable`、statusCode 408/409/429/5xx vs 4xx、文本模式、未知）；文案函数；
- `providers/agent-loop.test.js`（追加）：连接失败（未产出）→ 重试成功且 `onRetry` 事件齐全；连续失败到上限 → 抛且调用次数 = maxRetries+1；**已产出文本后断流 → 不重试**；**空闲超时（永不吐事件）→ 重建请求重试**；重试等待中用户中断 → 立即静默收场、不重试；强制收尾轮失败后再重试成功；
- `providers/openai-compat-model.test.js`（追加）：`reasoning-delta` 透传心跳（mock SST）；
- 集成 `entrypoints/web/run-openai.resume.test.js`（追加）：假 provider 注入极速 retry 参数，模型第一次 `fetch failed` → 循环内重试 → `model_retry` 落 journal + 活动行可见 + 回复落盘；
- e2e `tests/e2e-openai-retry.mjs`（新）：真 server + 假 SSE 端点**挂起流**（env 把空闲压到 700ms）→ 对账续跑的模型调用第一次挂死被判死 → 重试成功；断言模型恰被调用 2 次、无重复回复、journal `model_retry(idle)`、settled done、run-index 清空；
- 全量 `npm test` 回归；`npm run test:e2e` 对照基线（13/14 + 新用例）。

## 7. 实施状态

- [x] `providers/model-retry.logic.js` + 单测
- [x] `agent-loop.js` 步内重试 + 空闲看门狗（含收尾轮、partialText 语义、可中断退避）
- [x] `openai-compat-model.js` per-call 中断源 + `reasoning-delta` 心跳
- [x] `run-openai.js` `onRetry` 接线（journal + 活动行；子代理活动行）
- [x] 集成测试 + e2e 挂起流用例
- [x] spec / CLAUDE.md / 分析报告状态同步
