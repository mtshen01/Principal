# 上下文预算与压缩双触发（P0）· 设计

- 日期：2026-10-10
- 状态：已实现（本文档与实现一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §14 P0-①②；T7 spec `docs/superpowers/specs/2026-10-08-context-compaction-design.md`（本次在其上做「token 双触发」升级，T7 的决策史不重写）
- 范围：**openai-compat 路径**——新建 `capabilities/context-budget.logic.js`，改 `entrypoints/web/conv-compact.logic.js` / `entrypoints/web/run-openai.js` / `store/runs.js`。Claude 路径不动（SDK `autoCompactEnabled` 覆盖）。

## 1. 背景与问题

T7（2026-10-08）给 openai 路径上了「滚动摘要 + 原文保留 + 边界安全截断」，但触发与保留仍有两个盲区（Codex 对比分析 §14 取证）：

1. **触发只看条数**（`总−covered > 200`）：对「条数不多但每条很重」的会话（大工具输出/长文档/长代码）完全无感知——窗口先爆，压缩后知后觉；200 条对不同窗口模型（8k vs 200k）也一刀切。
2. **保留固定 100 条**：尾部消息本身很重时，压缩完模型视角仍然超窗（压了个寂寞）。
3. **usage 不落 journal**（原注释是刻意的）：事实流里没有 token 曲线，压缩点前后的上下文走势无法对照回放。
4. 摘要 prompt 是「保留项清单」的自由文本，多轮滚动后结构漂移；Codex 用固定小节（进度/约束/待办/数据）保证机器可检、人可扫读。

## 2. 目标与非目标

**目标**：

1. **预算中心化**：token 估算与「是否达阈值」的判定收口到唯一模块（`context-budget.logic.js`），调用方消费布尔量，不在编排层重算百分比；
2. **压缩双触发**：条数 > 200 **或** 估算 token ≥ 窗口 90%（对齐 Codex 缺省）即压；窗口未知只认条数（沿用「分母绝不猜」）；
3. **保留窗口 token 感知**：尾部估算超 20k tokens 时收缩保留窗口（不低于 20 条），沿 user 边界取整轮；
4. **摘要四要素**：固定「进度与决策 / 约束与偏好 / 待办与下一步 / 关键数据」四节，system prompt 与用户 prompt 共用同一常量防漂移；
5. **可观测**：每步 `usage` 落 journal（只记数字）；每次压缩落 `compaction` 事件（触发口径/前后估算/切点），与 usage 曲线对得上。

**非目标**：

- 真 tokenizer（bytes/4 启发式足够：偏差只影响触发**时机**，不影响正确性）；
- **turn 中途压缩**（agent-loop 步间再检查）——本次只在 run 开头（fresh/resume 共用）检查一次，中途压缩需要 agent-loop 加步前钩子，留后续任务；
- Codex 式摘要固定前缀（`SUMMARY_PREFIX`）——system 段头已有「## 历史摘要」标识，不叠床架屋；
- Claude 路径（SDK 自管压缩，不动）。

## 3. 拍板记录（2026-10-10）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 估算口径 | UTF-8 字节 ÷ 4 **向上取整**；图片固定估值 1844（同 Codex 7373 字节 ÷ 4 来源）；未知 part 类型返 0——宁可低估，不虚构 |
| 2 | 阈值 | 窗口 **90%**（与 Codex 一致，`AUTO_COMPACT_RATIO=0.9`）；窗口未知（null）只认条数——分母绝不猜 |
| 3 | 保留窗口 | 默认 100 条；从尾向前累计估算 token 超 **20k** 即停（保留越过预算的那条），不低于 **20** 条；仍沿 user 边界取整轮（`pickCompactCut` 不变） |
| 4 | 摘要格式 | 固定四要素小节，某节无内容也要保留标题；纯文本、总字数 ≤800（`MAX_SUMMARY_CHARS=2000` 兜底截断不变） |
| 5 | 可观测 | `usage` 每步一行（step/inputTokens/outputTokens/totalTokens/model/contextWindow，**不落文本**）；`compaction` 记 reason（tokens/tokens+count/count）/tokensBefore/tokensAfter/window/limit/visibleBefore/coveredBefore/coveredAfter/kept/summaryChars/model |

## 4. 设计

### 4.1 预算模块（新，`capabilities/context-budget.logic.js`，零 IO）

| 导出 | 职责 |
|---|---|
| `BYTES_PER_TOKEN=4` / `IMAGE_TOKEN_ESTIMATE=1844` / `AUTO_COMPACT_RATIO=0.9` | 口径常量 |
| `estimateTextTokens(text)` | UTF-8 字节 ÷ 4 向上取整；非字符串/空串 → 0 |
| `estimatePartTokens(part)` | text/reasoning/tool-call（名+input）/tool-result（output 序列化）；image 固定估值；未知 → 0 |
| `estimateJsonTokens(value)` | 对象序列化后估；字符串直测；不可序列化（循环引用等）→ 0 |
| `estimateMessageTokens` / `estimateMessagesTokens` | 单条/数组累计（content 字符串或 part 数组两形态） |
| `contextTokenStatus({ messages, summaryText, extraTokens, windowTokens, ratio })` | **唯一阈值判定点**：`{ tokens, window, limit, usageRatio, over }`；窗口未知时 limit/usageRatio 为 null、over 恒 false |

依赖方向：`entrypoints/web` → `capabilities`（向下，与 tool-policy 同向）；本模块不 import 任何上层。

### 4.2 压缩纯函数（改造 `entrypoints/web/conv-compact.logic.js`）

| 变更 | 说明 |
|---|---|
| 新增 `COMPACT_KEEP_TOKEN_BUDGET=20000` / `COMPACT_KEEP_MIN=20` | 保留窗口的 token 预算与条数下限 |
| 新增 `resolveKeepRecent(messages, {maxKeep, tokenBudget, minKeep})` | 从尾向前累计，超预算即停（保留越过预算那条）、不低于 minKeep；轻会话 = min(maxKeep, 长度)，与 T7 行为一致 |
| `shouldCompact` / `pickCompactCut` | **不变**（条数口径与切点安全约束原样保留；`pickCompactCut` 增加 `keepRecent` 实参，默认值不变） |
| 新增 `SUMMARY_SECTIONS` | 四要素小节常量（system 与 prompt 共用） |
| `SUMMARY_SYSTEM_PROMPT` | 改为四要素指令（替换原「保留项清单」表述） |
| `buildSummaryPrompt` | 末句改为「固定四个小节：…（总字数 ≤800）」 |

### 4.3 运行时（`run-openai.js#maybeCompactHistory`）

```
messages ← 已修复悬空 + 去头部孤儿的历史（含本轮 user 消息）
window   ← 本 run 模型的 context_window（凭证元数据；未知 null）   // 计算前移到压缩之前
summary  ← getSummary(convId)；covered = summary?.covered || 0
countOver ← shouldCompact({total, covered})
budget    ← contextTokenStatus({ messages: slice(covered), summaryText, windowTokens: window })
if countOver || budget.over:
   keepRecent ← resolveKeepRecent(messages)              // token 感知收缩
   cut        ← pickCompactCut(messages, { covered, keepRecent })   // 仍要求 user 边界 + minDrop
   摘要输入   ← 旧摘要 + messages[covered..cut)（同一套转录格式化）
   → 同凭证一次性零工具调用（fail-open 不变）
   → setSummary(convId, { text, covered: cut, at, model })
   → emitRunEvent('compaction', { reason, tokensBefore, tokensAfter, window, limit, … })
   → runActivity：tokens 口径报「估算约 N tokens，占窗口 x%」；条数口径沿用「历史较长（>200 条）」
```

- `reason` 取值：`tokens`（仅窗口口径）/ `tokens+count`（两口径同触发）/ `count`（仅条数）；
- `modelContextWindow` 的计算从原 hooks 区**前移到压缩之前**（压缩触发与 `onUsage` 共用同一分母）；
- 压缩仍 fail-open：失败只提示、本轮按原文继续。

### 4.4 usage 落 journal（`store/runs.js#runUsage`）

每步模型用量在广播 SSE 之外，追加一条 `usage` journal 事件（只记数字字段，见拍板 #5）。落盘量的口径：每次模型步一行、字段全是数字，3 天/5000 条保留窗口不变；跨刷新展示仍走会话记录（前端 meta），journal 面向排查与回放。压缩动作本身也因 `compaction` 事件成为事实流的一部分（T7 原设计「摘要调用不落 journal」被本次升级取代）。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 估算偏差（假 tokenizer） | 只影响触发时机；触发过晚由条数口径兜底；阈值可配（`contextTokenStatus.ratio`） |
| 窗口元数据缺失/异常 | `window` 为 null → 只认条数（与 T7 完全一致），绝不拍脑袋分母 |
| 收缩保留窗口丢近期上下文 | 下限 20 条 + user 整轮边界；`tokensAfter`/`kept` 落 journal，压缩效果可复查；原文永不丢（存储 backstop 不变） |
| journal 体量 | usage 只记数字；保留窗口 3 天/5000 条不变，超限走既有 jsonl 压缩 |
| 行为变化 | 轻量会话完全不变：token 未达 90% 且条数 ≤200 不触发；保留窗口对轻消息仍取 100 条 |
| 回滚 | 删除 `usage`/`compaction` 两个事件的 emit 即还原；`resolveKeepRecent` 传 `tokenBudget: Infinity` 即回 T7 保留口径 |

## 6. 测试策略

- `capabilities/context-budget.logic.test.js`（新，6 用例）：字节/多字节估算、JSON 与循环引用、各 part 形态（含图片固定估值、未知类型不猜）、消息累计、窗口未知不判过线、90% 边界（含摘要/预留计入与自定义比例）；
- `conv-compact.logic.test.js`（+2）：`resolveKeepRecent`（轻消息取 maxKeep / 重消息按预算收缩 / minKeep 兜底 / maxKeep 上限）、四要素（`SUMMARY_SECTIONS` 同时在 system 与 prompt）；
- `runs-journal.test.js`（+1）：`runUsage` 落 journal 且只含数字字段；
- `run-openai.resume.test.js`（+2 且既有两条压缩用例加断言）：**token 触发端到端**（10k 窗口 + 130 条重消息：条数未超而 token 超 → 压缩落盘、摘要 system 含四要素、journal `compaction.reason='tokens'`、保留窗口收缩）；**usage journal**（假 provider 上报用量 → journal 有 `usage` 事件）；条数触发用例补 `compaction.reason='count'` 与 `window=null`；
- 全量 `npm test` 回归（本次实测 3984 全绿）。

## 7. 实施状态

- [x] 预算模块 `capabilities/context-budget.logic.js` + 单测（6 用例）
- [x] 压缩纯函数升级：`resolveKeepRecent` + 四要素（`SUMMARY_SECTIONS` / system prompt / prompt 末句）+ 单测（+2 用例）
- [x] 运行时：`maybeCompactHistory` 双触发 + 窗口前移 + `compaction` 事件 + 提示文案分口径
- [x] `store/runs.js#runUsage` 落 `usage` journal + 单测
- [x] 集成测试：token 触发端到端 / usage journal（`run-openai.resume.test.js`）
- [x] 全量 `npm test` 3984 全绿
