# 发送前上下文 normalize（P0-③）· 设计

- 日期：2026-10-11
- 状态：已实现（本文档与实现一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §4「上下文管理」/ §14 P0-③；上游 spec：T7 `2026-10-08-context-compaction-design.md`、`2026-10-10-context-budget-and-compaction-v2-design.md`
- 范围：新建 `capabilities/context-normalize.logic.js`；改 `entrypoints/web/run-openai.js`（接线）、`entrypoints/web/conv-compact.logic.js`（`clipMiddle`/`dropLeadingOrphans` 迁出）、`entrypoints/web/run-openai.logic.js`（`repairDanglingToolCalls` 迁出）。Claude 路径不动（SDK 管发送）。

## 1. 背景与问题

Codex 的 `ContextManager` 是单一事实：`history` 存全量、`for_prompt`（`core/src/context_manager/history.rs:603`）发送前必过 normalize（`:969-976`：`ensure_call_outputs_present` / `remove_orphan_outputs`）。本项目对应能力散在两处、各管一段：

1. `run-openai.logic.js#repairDanglingToolCalls` 只补配对缺口（悬空 tool-call 合成「未执行」），且只在 openai 路径载入时触发一次；
2. `conv-compact.logic.js#dropLeadingOrphans` 只管**头部**孤立 tool 结果；
3. `clipMiddle` 只服务摘要输入——真正发给模型的超长单条消息反而没有兜底；
4. 空 assistant 消息（异常 `responseMessages` 落盘现场）会原样发给模型。

缺口要害是**不变量没有单一归属**：新增一条注入路径（未来的 steer/中途压缩/新 provider）就可能绕开修复。参照 Codex「截断有策略」（`utils/output-truncation/src/lib.rs:36` 保头尾丢中间），把修复、清理、截断收成一组「发送前必跑」的纯函数。

## 2. 目标与非目标

**目标**：

1. **不变量集**（唯一模块 `capabilities/context-normalize.logic.js`，零 IO）：
   - 配对：`normalizeSequence`——tool-call 就近配对（允许批内乱序）；结果存在但脱档 → **前拉**；不存在 → 合成「未执行」（原 repair 语义保留）；
   - 孤立清理：无对应调用/重复的 tool-result 剔除（不再只管头部）；
   - 剪空：空 assistant/tool 消息剪除；
   - 中间截断：单条超长消息 `clipMiddle`（60/40 保头尾 + 省略标记，从 conv-compact 迁入统一）；
2. **唯一组合点**：`normalizeForModel` = 配对 → 剪空 → 截断；干净序列原引用返回（零开销）；
3. **两个执行点**（都在 `run-openai.js`）：载入历史时（合成结果落盘）+ 构建请求前（防御性终检）；
4. 迁移收口：删除 `repairDanglingToolCalls` / `dropLeadingOrphans` 两处旧实现，测试随迁。

**非目标**：

- `stripUnsupported`（Codex 按模态裁剪附件/图片）——openai 路径的消息里根本没有 image/file part，也没有「当前模型支持什么」的能力源；等有真实消费方再加（挂起）；
- 每来源硬预算表（Codex 项目文档 32KiB 那类，分析报告 P1-②）——本层只给**统一兜底**与旋钮，不替工具层定策略；
- turn 中途 normalize（agent-loop 步前钩子）——同 P0-② 的「turn 中途压缩」，留后续任务；
- 存储结构变更：`conv-messages.json` 仍是全量账本，本层只修**视图**。

## 3. 拍板记录（2026-10-11）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 配对口径 | **就近**：result 必须紧跟本批 pending（可跨多条 tool 消息、允许批内乱序）才算数；进任何非 tool 消息前结清 pending。比旧实现「向前扫任意位置」严格——旧口径下「结果隔了 user 消息」仍然非法 |
| 2 | 脱档结果 | **前拉**（挪到调用后，保留真实结果）优于合成假「未执行」；前拉幂等、不落盘（存储不动，每次载入结果稳定）；找不到结果才合成 |
| 3 | 落盘口径 | 只有**合成**的消息进 `added` 落盘（否则存储永远缺这条、新消息接在断口后）；剔除/前拉/剪空/截断只作用于视图（存储是全量账本，`covered` 索引也按视图算） |
| 4 | 截断口径 | 默认 **120k 字符/part**：高于所有工具层硬上限（WebFetch 100k / Read 50KB / Bash 30k），只挡病态数据；中间截断 60/40 + 省略标记（与旧 `clipMiddle` 逐字一致）；json 大对象序列化后降级 text/error-text（截断后已非合法 JSON，如实降级）；tool-call 参数不动（历史事实陈述） |
| 5 | 剪空口径 | 只剪 assistant/tool 的无可发送内容消息；空 user/system 不剪——输入端约束由调用方负责，静默吞掉触发消息比多发一条空消息更糟 |
| 6 | 组合与快路径 | `normalizeForModel` 是唯一组合点；每个子步骤「无变化原引用返回」，干净序列整体零分配零 stats |

## 4. 设计

### 4.1 新模块（`capabilities/context-normalize.logic.js`，零 IO）

| 导出 | 职责 |
|---|---|
| `DEFAULT_UNEXECUTED_NOTE='进程中断，该工具未执行'` | 合成结果固定文案 |
| `DEFAULT_MAX_ITEM_CHARS=120_000` | 单 part 发送上限（`maxItemChars` 旋钮；非有限/非正 = 不截） |
| `clipMiddle(s, max)` | 中间截断（60/40 + `…（略 N 字符）…` 标记；从 conv-compact 迁入，摘要格式化共用） |
| `normalizeSequence(messages, {note})` | 配对 + 孤立清理；返回 `{messages, added, stats:{synthesized, droppedOrphans, moved}}`；预索引 `toolCallId → part 位置` 支撑前拉 |
| `pruneEmptyMessages(messages)` | 剪空；返回 `{messages, dropped}` |
| `trimLargeParts(messages, {maxChars})` | 单 part 中间截断；返回 `{messages, trimmed}`（part 数） |
| `normalizeForModel(messages, {note, maxItemChars})` | **唯一组合点**：配对 → 剪空 → 截断；stats 合并五项 + `added` |

### 4.2 迁移

| 旧位置 | 处置 |
|---|---|
| `run-openai.logic.js#repairDanglingToolCalls` | 删除（能力并入 `normalizeSequence`，含全部原用例） |
| `conv-compact.logic.js#dropLeadingOrphans` | 删除（头部孤儿是 `normalizeSequence` 的子集，原用例迁移） |
| `conv-compact.logic.js#clipMiddle`（私有） | 迁至新模块并导出；conv-compact 改 import（依赖方向 entrypoints → capabilities，向下） |

### 4.3 运行时接线（`run-openai.js`）

```
startOpenAiRun / resumeOpenAiRun:
  history ← loadNormalizedHistory(run, convId)
             = normalizeForModel(getMessages(convId))
             → added 落盘（appendMessages）+ 活动提示「已按「未执行」补记」
             → stats 有修正时 logger.info（moved/droppedEmpty/trimmed 留痕）

runOpenAiSession:
  summary     ← maybeCompactHistory(...)    // 消费的已是 normalize 后的视图
  viewMessages ← 摘要边界切片（或全量）
  prepared     ← normalizeForModel(viewMessages)   // 发送前终检（幂等；统计有缺口则 logger.warn）
  modelMessages ← [system(含摘要), ...prepared.messages]
```

- 载入时跑在**压缩之前**（compaction 的切点/估算/摘要输入都基于洗净的视图）；
- 发送前终检在**切片之后**（slice 沿 user 边界，正常零变化；防御未来新增注入路径）；
- `persistedCount = modelMessages.length` 游标语义不变（agent-loop 从 `modelMessages` 起跑，差量补写不受影响）。

### 4.4 可观测

- 合成补记：`runActivity`（用户可见，原文案不变）+ 合成消息落盘；
- 视图修正（前拉/剔除/剪空/截断）：`logger.info('web', '发送前 normalize 修正了历史序列', {...stats})`——用户无感，排障可查；
- 发送前终检发现缺口：`logger.warn`（理论不可达，出现即代表载入后有代码引入了新缺口）。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 前拉改变消息顺序 | 只把结果挪到它的调用后（canonical 顺序）；视图专用不落盘；幂等（第二次跑零变化，有测试钉住） |
| 剔除/剪空改变视图长度 vs `covered` 索引 | `covered` 本来按「load 后视图」计算（旧 `dropLeadingOrphans` 同口径）；最坏是跳过若干条近期消息，原文仍在存储，不丢数据 |
| 120k 兜底截断误伤 | 高于所有工具层硬上限，正常数据不触发；要更严/更宽传 `maxItemChars`（P1 硬预算表的挂点） |
| 行为回归 | 干净序列零变化（原引用返回），合法历史端到端与旧实现完全一致——resume/压缩集成测试 + 全量回归对照 |
| 回滚 | `run-openai.js` 改回旧的 repair + dropLeadingOrphans 即可；新模块是纯函数，无副作用、无存储格式变更 |

## 6. 测试策略

- `capabilities/context-normalize.logic.test.js`（新，25 用例）：`clipMiddle`；配对（合法/尾部悬空/多调用部分回/新 assistant 前/user 前/error 结果算配对/乱序/空入参）；孤立（头部/中部/重复/混合 part/全空）；前拉（单条/多 part/不重复/不与合成叠加/幂等）；剪空（三态 vs user/system）；截断（text/tool-result 字符串/json 降级/不可序列化/参数不动/旋钮）；组合入口（脏数据一次结清、stats 齐全、输入不动）；
- 迁移：`run-openai.logic.test.js` 只留 `resolveMaxSteps`；`conv-compact.logic.test.js` 去 `dropLeadingOrphans` 用例（`clipMiddle` 相关断言经 import 继续绿）；
- 集成：`run-openai.resume.test.js` 新增「顺序脏数据」用例（脱档结果前拉 + 空 assistant 剪除 + 不合成「未执行」且不回写存储）；
- 全量 `npm test` 回归；`npm run test:e2e` 对照基线。

## 7. 实施状态

- [x] 新模块 `capabilities/context-normalize.logic.js` + 单测（25 用例）
- [x] 迁移：`repairDanglingToolCalls` / `dropLeadingOrphans` / `clipMiddle` 三处收口，旧单测随迁
- [x] 接线：`run-openai.js#loadNormalizedHistory`（合成落盘）+ 发送前终检（幂等防御）
- [x] 集成测试：顺序脏数据端到端（`run-openai.resume.test.js`）
- [x] spec/CLAUDE.md/分析报告状态同步
