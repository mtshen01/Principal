# 自定义模型「上下文使用率」（顶栏额度区）· 设计

- 日期：2026-10-08
- 状态：已实现（用户点单）
- 关联：`src/providers/agent-loop.js`、`src/store/runs.js`、`src/entrypoints/web/run-openai.js`、`src/entrypoints/web/provider-models.logic.js`、`src/store/settings.js`、`public/js/{context-progress.js,context-usage.logic.js,chat.js,conv-store.js}`、`public/app.css`、`tests/e2e-context-usage.mjs`
- 背景（用户原话）：「自定义模型应该能看到上下文使用率吧，自定义的模型展示到上方的额度区域，额外展示上下文的使用率」。

## 1. 问题

顶栏右侧那块「额度区域」(`#contextProgress`) 只有一种数据源：Claude SDK 的 `ratelimit` 事件（额度圆点 + 重置时间）。自定义模型（openai-compat）没有额度事件 → 这块对自定义模型**永远是空的**；而自定义模型恰恰最需要知道「上下文快满了吗」——Claude 路径由 SDK `autoCompactEnabled` 自动压缩，自定义模型只有 T7 的按条数滚动摘要（200 条才触发，看不见水位）。

## 2. 数据链（本设计）

```
openai 模型步完成
  └─ agent-loop: hooks.onUsage({ step, inputTokens, outputTokens, totalTokens })   ← 本步，不是累计
       └─ run-openai: onUsage → runs.js#runUsage(run, { ...u, model, contextWindow })
            ├─ fanout 'usage'  → SSE → 前端
            └─ run.usage（内存，仅调试用）
前端 SSE 'usage'
  ├─ convSetContextUsage(convId, u)  → 会话记录 c.contextUsage = u（切会话/刷新后仍显示）
  └─ renderContextUsage() → ContextProgress.updateContextUsage(contextUsageView(u))
```

### 2.1 为什么用「本步 inputTokens」而不是累计

`agent-loop` 已经在累计 `inputTokens`（多步成本统计，`runResult` 用它）。但**累计值没有容量含义**：3 步各 30k 会显示 90k，而上下文其实只有 30k。上下文水位只有一个正确取数：**最新一次请求的 prompt tokens**。所以 `onUsage` 单独回调、给本步的值；收尾轮（强制收尾那次调用）也上报——那一刻通常最满。

### 2.2 分母：`/models` 的 `context_window`

`provider-models.logic.js#itemContextWindow` 兼容多家键名（`context_window` / `context_length` / `max_context_tokens` / `max_context_window`），非正数与非数字一律视为**未知**；`normalizeModelList` 只保留合法正整数。

> 为什么不让前端另存一张「厂商 → 窗口」静态表：它会随时间腐化（同厂商不同模型窗口不同），而 `/models` 元数据是服务商自己给的权威值。DeepSeek 实测会返回 `context_window`。

### 2.3 窗口未知时不显示百分比

只显示 `上下文 64k`（tooltip 里说明「该模型未提供上下文窗口」）。分母猜错比没有更坏——用户会拿这个百分比决定要不要新开会话，一个假分母会让他做出错误判断。

## 3. UI

- 顶栏同一块区域里两个互不依赖的元素：
  - **额度圆点**（Claude，原有行为不变；没有额度数据时不显示，不再谎报「额度正常」）；
  - **`上下文 27%` chip**（自定义模型）：颜色分档 <70 灰 / 70~89 黄 / ≥90 红，`tabular-nums` 防顶栏抖动；
  - 两者都没有 → 整块隐藏（保持「没数据不占位」的现状）。
- hover tooltip 行：`已用 64k / 128k tokens` + `最近一步输出 x tokens`（有则显示）+ 分档提示（剩余量 / 建议新开对话 / 已超出窗口）。
- 纯逻辑全部在 `public/js/context-usage.logic.js`（`formatTokens` / `contextLevel` / `contextUsageView`），组件只做 DOM。

## 4. 边界与取舍

| 场景 | 行为 |
|---|---|
| 窗口元数据缺失（多数中转站） | 只报 tokens，不算百分比（见 §2.3） |
| 用户刚换过模型 | 分母优先用**当前所选模型**的窗口（记录里那个窗口是上一次 run 的模型）；分子仍是最近一次请求的用量——这期间发消息会被新值覆盖 |
| 会话记录里没有用量（老会话 / 新会话） | 顶栏隐藏，直到该会话跑一步模型 |
| `Task` 子代理的一次性调用 | **不上报**：它的 prompt 是子任务，不代表主会话上下文 |
| journal | `runUsage` 刻意不落盘：每步一条会把事实流撑大；跨刷新恢复走会话记录，不依赖服务端重放 |
| 会话列表排序 | `convSetContextUsage` 不动 `updatedAt`（同 draft 的取舍），否则运行中的会话会被反复顶到最前 |
| Claude 会话 | 暂不显示（SDK 侧自动压缩；要显示需在 run-claude 里接 per-message usage，属后续增强） |

## 5. 验证

- 单测：`public/js/context-usage.logic.test.js`（格式化/分档/窗口未知不算百分比/空数据隐藏）、`src/providers/agent-loop.test.js`（onUsage 每步一次、收尾轮也上报）、`src/entrypoints/web/provider-models.logic.test.js`（多键名解析 + 非法值丢弃）、`src/store/settings.test.js`（normalizeModelList 保留 contextWindow）。`npm test` **3774 全绿**。
- e2e：`tests/e2e-context-usage.mjs`（自起 server + 假 OpenAI 端点 + 真浏览器）：① 有窗口元数据 → 顶栏 `上下文 50%`、圆点隐藏、tooltip `64k / 128k`、用量落进会话记录、刷新后仍显示；② 无窗口元数据 → `上下文 64k` 且不出现百分比。`npm run test:e2e` **13/13**。

## 6. 后续（未立项）

- Claude 路径的上下文使用率（run-claude 接 per-message `usage`）；
- 用量入库（journal `usage` 事件 / run-index 快照），让新窗口/换机器也能看到上一次的水位；
- 阈值联动 T7 压缩（≥90% 主动触发一次滚动摘要，而不是等 200 条）。
