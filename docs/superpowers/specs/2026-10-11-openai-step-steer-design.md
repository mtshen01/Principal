# openai 步边界 steer（P1-10）· 设计

- 日期：2026-10-11
- 状态：已实现（与本文档一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §11「可借鉴 1」（原文：steer 抢占当前流（openai 路径）——现在 follow-up 要等 run 终结；对齐 Codex：steer 消息到达时切断当前模型请求，把消息并进 convo 立刻重发）；上游依赖 T2-P4 busy inbox（能力位/持有区/排队 UI）、P0-④ 模型流重试（per-call abort 先例）、P1-9 follow-up 落盘（存量恢复）
- 范围：`src/providers/agent-loop.js`（步边界注入 + 抢占）、`src/store/runs.js`（`consumeHeldMsgs` 增 `via` 参数）、`src/entrypoints/web/run-openai.js`（能力位 + hooks）、`src/entrypoints/web/routes-run.js`（`/msg/now` 的 step 分支）。**不改前端、不改 Claude 路径行为**。

## 1. 背景与问题

- openai 路径此前**不做 steer**（`run-openai.js` 旧注释：「openai 没有「工具执行中途」恢复 API」）：同 conv 运行中的新消息一律 follow-up 排队，**等当前 run 终结**才由 conv-inbox 排空起下一轮。用户纠偏的价值在延迟——一句话要等整个任务跑完才被看到。
- Claude 路径的 steer（`heldMsgs` 持有区 + `_input.push` + `q.interrupt()`）证明本仓库的 steer 骨架（持有/撤回/立即生效/consumed 广播/unsent 兜底）是现成的；缺的只是 openai 侧的「输入流」等价物。
- Codex 的做法（`session/input_queue.rs`）：steer 输入进 `pending_input`，`watch_user_input` 在输入到达时 **cancel preempt token 提前切断当前采样流**，循环尽快取到新输入——「抢占 + 并入对话」。
- openai 的 agent-loop 是手搓的，天然拥有 step 循环与 per-call abort（P0-④ 已建）——「步边界注入 + 无可见产出时抢占」不需要新基建，只需要两个新 hooks。

## 2. 目标与非目标

**目标**

1. **步边界注入**：steer 消息（`run.heldMsgs`）在 agent-loop 的步边界被取出、按序追加为 user 消息进 convo（落检查点），模型下一步立即可见：
   - 每步模型调用**之前**（上一步工具执行完 / 抢占后重来）；
   - **最终答复边界**：`finishReason !== 'tool-calls'` 时，若已插话且预算还有余量，**不结束 run**——注入后继续下一轮（把插话当新指令答）。
2. **抢占（Codex preempt 对位）**：steer 到达且**本轮 attempt 尚无任何可见产出**（无 text、无活动）时，切断当前模型请求（per-call abort）并在同一步号重来——静默思考期的纠偏秒级生效，且不丢任何已展示内容。
3. **能力位升级**：openai 起跑/续跑置 `capabilities.steer = true` + `capabilities.steerMode = 'step'`；`/send`、`/start` busy 路由、飞书注入全部走持有区（与 Claude 同骨架），`/msg/now` 对 step 模式回执 `ok:true`。

**非目标**

- **不做已产出文本的强抢占**：文本/活动已经流到用户眼前（`onText` 已渲染），切断这个 attempt 会让「界面有、历史无」——模型下一轮看不到自己刚说的话，且工具调用半截（有活动无结果）。等本轮结束、边界注入（步边界语义的诚实边界）。
- **不做工具执行中途打断**：工具执行中 steer 只排队等待，下一个步边界注入。
- **不改前端**：`queue`/`consumed`/`unsent` 事件与 `mode:'steer'` 响应都是 Claude 侧已消费的既有契约。
- **不给 Claude 换成 step 模式**：SDK 输入流 + `interrupt()` 的 turn 语义保留（`steerMode` 缺省 = turn 风格）。
- **不删 follow-up 队列**：能力位与机制保留（P1-9 落盘/恢复继续服务存量队列与无 steer 的 provider）；openai 只是不再产生新排队项。

## 3. 拍板记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 注入通道 | 复用 `run.heldMsgs` 持有区（B 骨架全复用：撤回/立即生效/consumed/unsent/幂等认领）；agent-loop 侧新增 hooks `takeSteerMessages()`（取走 + 记 `steer_consumed via='step'`）与 `shouldPreempt()`。 |
| 2 | 注入形状 | 每条持有消息一条 `{role:'user', content:text}`，按序 push 进 convo；批量走 `onMessages` 检查点（崩溃续跑/压缩后都在）。 |
| 3 | 抢占条件 | 仅当**本 attempt `!emitted`**（无 text/无活动）且 `shouldPreempt()` 为真；用 250ms 轻量巡检（模型流静默期没有事件可查，Codex 靠事件取消是因为它同进程拥有采样流；我们跨 store/provider 边界，巡检是最小侵入）。 |
| 4 | 抢占的预算语义 | 抢占**不算一步**（`step--` 后同号重来），不重试、不记失败；journal 里由 `steer` + `steer_consumed(via=step)` 两条事实还原。 |
| 5 | 最终答复边界 | 预算守卫：仅当 `step+1 < budget` 时注入并继续；预算已尽则消息留在持有区，走 unsent 兜底。 |
| 6 | 收尾轮（wrap-up） | 不注入、不抢占（run 正在谢幕；消息留持有区 → unsent）。 |
| 7 | 未消费兜底 | 沿用 Claude 语义：`unsentField` 标 `steer_unsent` + done 附 `unsent` ids；有飞书通知登记的 conv 由 conv-notify 自动重注入。**不做**「openai 专用自动转 follow-up 队列」——避免与 conv-notify 双投递，且尊重「用户主动停止后不偷偷起新 run」。 |
| 8 | `/msg/now` | step 模式：无 SDK 输入流可 flush/interrupt——到达即已尝试抢占、最近步边界必注入，回执 `ok:true`（比 Claude 判档窗口的 `ok:false` 更「立即」）。Claude 路径逐字不变。 |
| 9 | `consumeHeldMsgs` 复用 | 增可选 `via` 参数（缺省 `'quota'`，Claude 调用不变）；step 路径 `consumeHeldMsgs(run, 'step')`，replay reducer 已按 `via` 展示，无需改。 |
| 10 | 能力位 | `steer=true` + `steerMode='step'` **取代** openai 的 `followUp=true`（steer 在场时所有路由都先判 steer，followUp 成为死配置）；`run-openai` 起跑与续跑两处同步。 |

## 4. 设计

### 4.1 agent-loop（`src/providers/agent-loop.js`）

- `runModelStep` 增参 `preempt`；attempt 内若启用则：
  - 武装 250ms 巡检：`!emitted && hooks.shouldPreempt()` → resolve 抢占 race；
  - race 命中 `PREEMPT`：`attemptAbort.abort()`（切断底层请求）→ 抛 `code='steer_preempt'`；
  - catch 里**先于** `classifyModelError` 直抛（不重试、不算失败、无 partialText——本就没有产出）；
  - `finally` 清巡检定时器。
- `runAgentLoop`：
  - `takeSteer`/`preemptEnabled` 从 hooks 推导（**两者同时提供才开抢占**——只有 shouldPreempt 没有 takeSteer 会无限抢占）；
  - `injectSteers()`：取消息 → 组 user 消息 → push convo → `onMessages` 检查点 → 返回条数；
  - 步顶调用一次；`finishReason !== 'tool-calls'` 边界处「预算有余 + 注入成功 → `continue`」；
  - 主步调用传 `preempt: preemptEnabled`；catch 到 `steer_preempt` → `step--; continue;`（同一步号重来）；
  - **收尾轮不传 preempt**。

时序（抢占 → 注入 → 重来）：

```
步 N modelRun(convo) ──流静默/思考中── steer 到达（heldMsgs+1）
   巡检命中 → abort 本次请求 → 抛 steer_preempt → 步号不变
步 N' 顶部 injectSteers() → convo += {user: 插话}（onMessages 落检查点）→ modelRun(convo') 正常跑
```

### 4.2 runs.js

- `consumeHeldMsgs(run, via = 'quota')`：`emitRunEvent('steer_consumed', {msgIds, via})` 用参数值；其余逐字不变（返回 `[{id,text}]`）。
- （不动 `flushHeldMsgs`/`withdrawHeldMsg`/`unsentField`。）

### 4.3 run-openai.js

- 起跑/续跑：`run.capabilities.steer = true; run.capabilities.steerMode = 'step';`（替换原 `followUp = true` 两处；注释说明 pivot 与队列的去处）。
- hooks 增：
  - `takeSteerMessages: () => consumeHeldMsgs(run, 'step')`
  - `shouldPreempt: () => run.heldMsgs.length > 0`

### 4.4 routes-run.js

- `handleRunMsgNow`：`caps.steer` 且 `caps.steerMode === 'step'` → 直接 `ok:true`（在 `_input` 检查**之前**分支；Claude 无 `steerMode`，行为不变）。

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 抢占打断正在成形的工具调用 | `!emitted` 守卫：任何 tool-call 事件都会置 `emitted=true`，之后只能边界注入 |
| 巡检定时器泄漏 | 每次 attempt 的 `finally` 清理；只在启用抢占（openai hooks）时武装 |
| 只有 shouldPreempt 没 takeSteerMessages → 无限抢占 | `preemptEnabled` 双条件推导（单测覆盖） |
| 最终答复边界注入后模型重复长答 | 注入的是新 user 消息，模型自然进入「响应插话」；预算守卫防住超限场景 |
| 消息在 run 谢幕窗口未消费 | 既有 unsent 兜底（Claude 同款）：done 附 `unsent`、UI 标记可重发、飞书登记 conv 自动重注入 |
| 存量 follow-up 队列失宠 | P1-9 恢复/排空机制原样保留；只有 openai 不再产生新排队项（spec §2 非目标） |
| Claude 行为被误伤 | Claude 不设 `steerMode`；`/msg/now` 分支前置但仅命中 step；单测对比运行 |

回滚：还原 `run-openai.js` 的 `steer=true/steerMode` 两行即回到 follow-up 排队（可先只回滚能力位，agent-loop 新 hooks 无副作用）。

## 6. 测试策略

- `agent-loop.test.js`（5 条）：工具往返间边界注入（下一轮请求带 user 消息 + onMessages 检查点）/ 最终答复边界注入并继续 / 抢占切断（模型调用 2 次、同号重来、注入后完成）/ 已产出不抢占（等本轮结束再注入）/ 预算耗尽不消费（takeSteer 不被边界调用）。
- `runs-held.test.js`：`consumeHeldMsgs(run,'step')` 返回消息且 journal 记 `via='step'`。
- `routes-run.test.js`：step 模式 `/send` 进持有区（mode:steer + hm_ id）；`/msg/now` → `ok:true`。
- 快照 `run-openai.snapshot.test.js` 新增 s5：真 run-openai + 假 provider，工具往返中 `holdMsg` → 第二次模型调用包含注入的 user 消息（快照锁两轮发送面）；断言 `steer_consumed via=step` 落 journal。
- 全量回归 + CI e2e 子集（openai-resume / openai-retry）守绿。

## 7. 实施状态

- [x] `agent-loop.js` 步边界注入 + 抢占 + 单测
- [x] `runs.js#consumeHeldMsgs` via 参数 + 单测
- [x] `run-openai.js` 能力位与 hooks
- [x] `routes-run.js` `/msg/now` step 分支 + 单测
- [x] 快照 s5 + journal 断言
- [x] CLAUDE.md（providers / entrypoints / store）与报告 §11/§14 状态同步
