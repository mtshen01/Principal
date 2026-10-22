# follow-up 队列落盘 + 任务清单（plan）持久化（P1-9）· 设计

- 日期：2026-10-11
- 状态：已实现（与本文档一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §4「P1-④ 计划外化」（原文：follow-up 队列落盘 → 重启后由对账恢复排空；plan 存 conv 级存储，压缩/续跑后重新注入）；上游依赖 T2-P4 busy inbox、P0-② 压缩 v2
- 范围：新增 `src/store/conv-followups.js`(+test)、`src/store/conv-todos.js`(+test)；`store/runs.js` 加两个落盘 sink + 启动恢复 API；`entrypoints/web/run-durability.js` 注册 sink；`conv-inbox.js` 加启动恢复；`server.js` 接线；`run-openai.js` / `run-claude.js` 注入任务清单。**不改变 busy inbox / TodoWrite 的既有语义**。

## 1. 背景与问题

- **follow-up 队列纯内存**（`runs.js` 注释自认）：「openai run 进行中收到的新消息排队，run 终结后起下一轮」这条链，进程一重启队列就丢——用户排进去的话静默消失。journal 里有 `follow_up` 事件，但它是**诊断流**（文本截断 2000 字符、3 天窗），不能当恢复源。
- **任务清单（plan）无持久化**：`run.todos` 是进程内快照，只服务当轮 UI 面板。三处失真：重启/续跑后面板空白；openai 路径压缩把早期 `TodoWrite` 调用丢出模型视野后就「失忆」——模型不记得自己做到哪了，容易重复劳动或跑偏（Codex 用 plan 重注入对抗的正是这个）。
- Codex 的做法（`core/src/tools/handlers/plan.rs`）：plan 是工具维护的 checklist，**存会话侧、压缩后重建注入**——「计划外化」是超长任务的低成本核心手段。

## 2. 目标与非目标

**目标**

1. **follow-up 队列落盘**：队列的三个状态迁移（enqueue / cancel / take）经 sink 单向镜像到 `conv-followups.json`；进程重启后由启动恢复（hydrate）并回内存；对「无 running run」的 conv **立即补排空**（覆盖「run 已终结但队列未排空就崩了」的窗口——那份队列没有终结口可等了）。
2. **plan 持久化 + 重注入**：`TodoWrite` 每次覆盖式写盘（`conv-todos.json`）；run 开始时恢复 `run.todos`（面板续挂）并渲染成「任务清单」小节，追加在 openai 路径 system 尾部 / Claude 路径 `systemPrompt.append` 尾部——压缩丢了早期 TodoWrite 调用，清单仍在。

**非目标**

- 不新增 `update_plan` 工具：仓库已有 TodoWrite（两端接线 + 面板 + 策略门分类），Codex 的 plan 语义由「TodoWrite + 跨压缩重注入」承担；再引入一个同义工具只会造成双份状态。
- 不从 journal 重放恢复（截断 + 3 天窗，拿它当恢复源是把诊断流当账本）。
- 不做前端改动（`run.todos` 经既有 attach/SSE 通道到面板；队列经既有 `/api/run/pending` 与队列展示）。
- 不做跨会话 plan 共享 / 多 agent mailbox（属 P2 agent 协作范畴）。

## 3. 拍板记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 落盘层归属 | `runs.js` 维持「纯内存注册表」宪法：新增 `registerFollowUpSink` / `registerRunTodosSink`，磁盘 IO 全在 sink 实现（与 journal sink 同范式，真实接线在 `run-durability.js`）。 |
| 2 | 恢复语义 | hydrate 只并回内存、**不回调 sink**（数据来自盘上，无需回写）；按 id 去重保证幂等。 |
| 3 | 启动排空 | `restoreFollowUpInbox()`：hydrate → 对每个有队列的 conv，无 running run 才排空（有在跑的交给它的终结口——与常规并发守卫同语义）。 |
| 4 | 失败纪律 | 与 journal / run-index 一致「尽力而为」：读失败按「无队列/无计划」继续并留日志；sink 写失败吞掉留日志；绝不改变主链（入队、排空、run 收尾、SSE）。 |
| 5 | plan 存储与形状 | `conv-todos.json` 只存最近一次 `TodoWrite` 快照 `{ todos, at, runId }`；归一形状 `{content, status∈pending/in_progress/completed, activeForm?}`、50 项上限、300 conv 上限（超量按 at 淘汰最旧）。 |
| 6 | 注入时机与位置 | 只在 **run 开始**重建 system 时注入（压缩发生在同一构建点之前，天然覆盖「压缩后失忆」）；运行中 TodoWrite 不必回灌 system——模型自己刚写过。 |
| 7 | 注入内容 | 渲染 `[- [x]/[>]/[ ] content（进行中：activeForm）]` + 一行用途说明；空清单不注入；不向用户复述。 |
| 8 | Claude 路径 | 同样恢复 + 注入（`systemPrompt.append` 尾部）。SDK 自有会话历史不冲突：清单是「世界状态」区，重复出现无害。 |
| 9 | 破坏性 | 除 run 起点多读一次 JSON（缺失即 null）外无行为变化；新增文件独立，删文件即回滚。 |

## 4. 设计

### 4.1 follow-up 队列落盘

- `src/store/conv-followups.js`（形状 `{ v:1, convs: { [convId]: item[] } }`，item 形状见 `runs.js#buildFollowUpItem`）：
  - `applyFollowUpOp(op)` — `{type:'enqueue'|'cancel'|'take', convId, item?, id?}`；enqueue 按 id 幂等去重（sink 重放安全）、cancel 移除后空键删除、take 删键；未知 op 不改盘。**损坏即抛**（store 层惯例），吞错在上层。
  - `readAllFollowUps()` / `clearAllFollowUps()`（恢复与测试）。
- `runs.js`：`registerFollowUpSink(fn)`（fn=null 清除；调用兜底吞异常）+ 三个迁移点 `noteFollowUp(...)` + `hydrateFollowUps(convId, items)` + `listConvsWithFollowUps()`。
- `run-durability.js#startRunDurability`：注册 sink → `applyFollowUpOp`，写失败 warn 吞掉。
- `conv-inbox.js#restoreFollowUpInbox(deps)`：读盘（失败 warn 后按空继续）→ hydrate → 空闲 conv 补排空（`drainFollowUps({convId, id:null}, deps)`）。`server.js` 在 `startConvInbox()` 后调用（晚于 `recoverPendingAndOrphans()`，续跑占用的 conv 不会被抢跑）。

时序（崩溃窗口 -> 恢复）：

```
排队 → [崩溃] → 重启 → restore：hydrate → 该 conv 无 running run → drain → 起新 run（follow_up_started 照旧落 journal）
                       → 该 conv 有 running run（reconcile 已续跑）→ 不动，等它的终结口
```

### 4.2 plan 持久化 + 重注入

- `src/store/conv-todos.js`（形状 `{ v:1, convs: { [convId]: { todos, at, runId } } }`）：
  - `getConvTodos(convId)` / `setConvTodos(convId, todos, {runId, now})`（空列表删键）/ `clearAllConvTodos()`；
  - `sanitizeTodos(list)`（纯，形状与 `providers/builtin-tools.js#normalizeTodos` 对齐；store 不反向 import providers，本地实现）；
  - `renderPlanSection(todos)`（纯）：空 → `''`；否则「`## 任务清单（…）` + 逐行标记」。
- `runs.js`：`registerRunTodosSink(fn)`；`runTodos` 广播后回调 sink（`{runId, convId, todos}`）；`hydrateRunTodos(run, todos)`（已有内容不覆盖、不走 sink）。
- `run-openai.js#runOpenAiSession`：起跑即 `getConvTodos(convId)` → `hydrateRunTodos`；system 构建处 `composeSystemWithSummary(...) + planSection`。
- `run-claude.js#startClaudeRun`（续跑也经它）：同样恢复；`systemPrompt.append` 尾部拼接 `planSection`。

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| sink 写失败打挂主链 | 双层兜底：`runs.js` 调用点 try/catch 静默 + 接线层 try/catch 留日志；最坏结果「崩后丢队列/丢计划」，不差于现状 |
| 启动补排空「替用户跑了旧消息」 | 语义上队列本来就是「等前一轮终结就跑」；补排空只对无 run 在跑的 conv 生效，且与 reconcile 同为启动恢复策略 |
| hydrate 与 sink 双写/重复 | hydrate 不走 sink；enqueue 落盘按 id 去重（sink 重放安全） |
| 写放大 | conv-todos 每次 TodoWrite 一次小 JSON 读改写（≤50 项）；conv-followups 仅在入队/撤回/排空时写 |
| 注入让 system 变长 | 清单 ≤50 行短句；空清单不注入；快照 s1-s3 无 plan 保持不变，新增 s4 锁定注入形态 |
| 文件膨胀 | conv-todos 300 conv 上限（按 at 淘汰最旧）；conv-followups 无上限——有排队项意味着有待交付的用户消息，绝不静默丢 |

回滚：删除 `conv-followups.js` / `conv-todos.js` 两个文件与相关接线，即回到纯内存现状；盘上残留文件被忽略。

## 6. 测试策略

- **store 层单测**：`conv-followups.test.js`（往返/幂等/三迁移/损坏即抛/清理）；`conv-todos.test.js`（归一与往返/空删键/render 标记/上限淘汰/清理）。
- **runs.js 镜像单测**（`runs-mirror.test.js`）：sink 通知序列与载荷、sink 抛错被吞、hydrate 去重且不回调 sink、`hydrateRunTodos` 不覆盖已有。
- **接线单测**：`run-durability.test.js` 追加（入队→文件、take→清键、TodoWrite→文件、损坏文件吞错）；`conv-inbox.test.js` 追加（restore hydrate + 空闲补排空 + busy 跳过 + 读盘失败不炸）。
- **fs 级集成**：快照测试新增 s4（plan 注入 system + `run.todos` 恢复）与「TodoWrite → 落盘」；快照文件重录后人工 review。
- **全量回归**：基线 4032 + 本项新增。

## 7. 实施状态

- [x] `conv-followups.js` / `conv-todos.js` + 单测
- [x] `runs.js` sinks + hydrate + `runs-mirror.test.js`
- [x] `run-durability.js` / `conv-inbox.js` / `server.js` 接线 + 测试
- [x] `run-openai.js` / `run-claude.js` 注入（读失败 fail-open）+ 快照 s4
- [x] CLAUDE.md（store / entrypoints）与报告 §14 状态同步

## 8. 修订：面板续挂只在「续跑」时做（2026-10-16）

**背景（用户报告）**：一条会话第一轮有任务清单面板，之后**每一轮**都还带着同一份清单——而那份清单
常常是上一轮（甚至前一天）的快照，模型本轮根本没碰过它。用户看到的是「上一轮的内容被复制进了新一轮」。

**判定**：实现把「面板续挂」和「系统提示注入」绑在了同一个起跑 choke point 上，于是**新起一轮**也会
先把落盘快照挂出来。但 §1 里要修的问题是「重启/续跑后面板空白」——那说的是**继续同一份活**的场景；
新起一轮该怎么显示，本该由本轮自己的 `TodoWrite` 决定（模型一动清单，面板照常出现，进度可见性不变）。

**改动**（只动 UI 面板的挂载时点，不动持久化、不动注入）：

- 面板续挂判据显式化：Claude 侧 `run-claude.logic#isContinuationRun({resumePendingId, resumeAttempt})`
  （`doResume` 的三个来源：额度续跑 / 异常重试 / 重启孤儿恢复都会带这两个标记）；openai 侧由
  `resumeOpenAiRun` 给 `runOpenAiSession` 传 `continuation: true`。
- **不变**：`getConvTodos` → `renderPlanSection` 的 system 注入**每轮照做**（清单是「世界状态」，
  压缩丢调用后模型仍要知道自己的计划）；`TodoWrite` 快照照旧经 sink 落盘（下一轮的注入源）。
- **补充**：前端 `paintJob` 在 `job.todos` 为空时**撤下**已有面板（原先只处理非空分支，清单被清空后
  旧面板会留到本轮结束/切会话整体重绘）。

**测试**：快照 s4 改为断言「新起一轮不预挂面板 + 系统仍带清单」，并新增续跑用例断言面板续挂；
`run-claude.logic.test.js` 覆盖 `isContinuationRun` 的四种入参形态；新增 e2e
`tests/e2e-todo-panel-scope.mjs`（面板按会话隔离 + 清空即撤下）。
