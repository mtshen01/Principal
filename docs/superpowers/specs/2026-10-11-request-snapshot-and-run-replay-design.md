# 请求快照测试 + run 回放 reducer（P1-12）· 设计

- 日期：2026-10-11
- 状态：已实现（与本文档一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §12（可借鉴 2/3）与 §14 P1-12；上游依赖 P0-①②③（上下文线：预算/压缩/normalize）
- 范围：新增 `src/store/run-replay.logic.js`(+test)、`scripts/replay-run.mjs`、`src/entrypoints/web/run-openai.snapshot.test.js` + 快照文件、`package.json` 的 `replay:run` 脚本；文档同步。**不改变任何运行时行为**。

## 1. 背景与问题

- P0-①②③ 把「模型看到的请求」收成了新链路（预算估算 → 压缩 → 发送前 normalize → system 组装），但**发送面没有金标准测试**：语义靠一组细粒度单测与手写断言兜底，「N 步后模型实际收到的确切序列」在测试里没有被整体锁定。任何一处改动都可能悄悄多一条/少一条消息、把截断挪位、让摘要没挂上 system——现有测试不一定红。
- run-journal 已是 run 生命周期的事实流（submitted / usage / compaction / model_retry / steer / settled…，P2 起只写不读），但**没有消费方**：排查仍靠 grep 原始 jsonl，压缩点与 token 曲线对不上「一屏可读」的时间线。Codex 的做法是热路径只写原始事件、离线再解释（reducer）——本项是为自己的 journal 补上解释层。

## 2. 目标与非目标

**目标**

1. **发送面快照**：fs 级集成测试经假 provider 捕获「每次模型调用实际收到的 messages + 本轮暴露的工具名」，与 JSON 快照逐字比对。三个场景覆盖 P0 改造的全部风险面：
   - s1 多步工具循环：第 0 步请求 + 带工具结果的第 1 步请求；
   - s2 脏历史 normalize：悬空调用补记、脱档结果前拉、空消息剪除、超长消息中间截断；
   - s3 压缩触发：摘要调用（压缩器 system + transcript）与压缩后主调用（system 挂摘要 + 保留窗口）两张快照。
2. **回放 reducer**：`reduceRunTimeline(events)` 纯函数把 journal 事件归约成时间线数据（状态、steer 生命周期、压缩点、重试、审批、token 曲线），`formatRunTimeline(timeline)` 出人读文本；CLI `scripts/replay-run.mjs` 按 runId 打印（默认文本 / `--json` 全量）。

**非目标**

- 线格式（HTTP wire）快照：组装层是 P0 改造的全部风险面；wire 由 adapter 单测 + e2e 行为断言覆盖。入 wire 快照会同时引入环境与 SDK 版本双重噪声，收益不抵维护成本。
- 前端回放视图：reducer + CLI 先行，UI 按需再接（reducer 输出即可视化数据源）。

## 3. 拍板记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 快照捕获层 | 假 provider 包装 `modelRun`，逐次调用捕获 `messages`（深拷贝）+ 该轮 `input.tools` 的键名集合。不碰真网络，真 run-openai / 真 normalize / 真压缩。 |
| 2 | 快照存储 | `src/entrypoints/web/__snapshots__/run-openai-requests.json`（JSON、可 review、随 git 提交）；`UPDATE_SNAPSHOTS=1 npm test -- run-openai.snapshot` 重录，失败信息带更新指引。 |
| 3 | normalize 规则 | ① 临时数据目录路径 → `<DATA>`；② 平台名 `Windows/macOS/Linux` → `<OS>`；③ ISO 时间戳 → `<TS>`；④ 长度 > 400 的字符串 → `{ $len, head(60), tail(60) }`（截断事实由 `$len` 与头尾锚定）。规则显式列在测试文件里，改规则 = 改测试 = 可 review。 |
| 4 | 场景集 | 只选三个代表场景（s1/s2/s3，见 §2）；每场景快照按名存放。不锁「无价值噪声」：activity/事件流/计数器一律不入快照。 |
| 5 | 快照断言之外 | 每场景另加少量语义点断言（如「两步调用」「normalize 后悬空调用有合成结果」「system 挂上摘要」），快照变红时能一眼看出坏在哪；避免只有 JSON diff 的天书。 |
| 6 | 回放输入 | journal 事件数组；reducer **只读、纯函数、零 IO**。`runId:null` 的独立事件（abandoned）不在 reducer 范围。 |
| 7 | 回放状态口径 | 有 `settled` → 其 status；无 settled 但有事件 → `unsettled`（崩溃现场）；无事件 → `unknown`。 |
| 8 | 未知事件容忍 | reducer 白名单式映射，未知 type 记入 `unknownTypes` 数组而非抛错——journal 加事件不炸回放，补映射即可。 |
| 9 | CLI 数据目录 | `--data-dir` 在动态 `import` store 前设置 `APP_DATA_DIR`（store 路径在模块求值时定死，静态 import 会拿到默认目录）。 |
| 10 | 破坏性 | 无。全为新增测试/脚本/只读模块。 |

## 4. 设计

### 4.1 发送面快照（`run-openai.snapshot.test.js`）

- 隔离范式同 `run-openai.resume.test.js`：`mkdtemp` 私有 `APP_DATA_DIR` → 动态 import；同 id 覆盖假 provider；`setBuiltinMcp('context7', {enabled:false})` + `setRepoMapEnabled(false)` 掐掉机器相关工具与地图注入。
- 假 provider 的 `run(input, hooks)` 内：
  ```
  const calls = [];
  const capturingModel = (messages, opts) => { calls.push(clone(messages)); return scriptedModel(messages, opts); };
  runAgentLoop({ messages: input.messages, modelRun: capturingModel, executeTool: input.executeTool, signal }, hooks)
  ```
  同时记 `Object.keys(input.tools || {}).sort()`。压话轮（`summarizeSpan`）与主轮各产生一组捕获，按调用顺序存入 `captures`。
- 场景落点：
  - s1：seed 工具循环两步脚本（Read `hello.txt` → 文本收尾），快照两次 `modelRun` 的 messages；
  - s2：seed 脏历史（悬空 tool-call / 脱档结果 / 空 assistant / 130k 字符 user）+ 新 prompt，快照单次调用；
  - s3：seed 211 条小消息触发条数口径 + 脚本第一步给摘要、第二步给正文，快照摘要轮与主轮。
- 快照比较：读 JSON → 缺名或 `UPDATE_SNAPSHOTS=1` 时写入并在现场打印 `[snapshot] 已写入 xxx`；否则 `assert.deepStrictEqual(normalize(actual), saved)`，失败信息附「重录命令」。

### 4.2 回放 reducer（`run-replay.logic.js`）

- 事件 → 时间线映射（白名单）：
  `submitted`（meta：provider/model/effort/mode/ultracode/cwd/requestId/resumeAttempt）、`started`（pid）、`resumed`、`session`、`usage`（token 曲线）、`compaction`、`model_retry`、`steer`/`steer_withdrawn`/`steer_consumed`/`steer_unsent`、`follow_up`/`follow_up_cancelled`/`follow_up_started`、`ask`/`decision`、`policy_block`、`result`、`settled`。
- 输出结构（稳定字段名，UI 可直用）：`{ runId, convId, status, submittedAt, endedAt, durationMs, firstSeq, lastSeq, eventCount, unknownTypes, meta, startedPid, sessionId, resumes[], tokens[], compactions[], retries[], results[], settled, steer{held,withdrawn,consumed,unsent}, followUps{queued,cancelled,started}, asks[], decisions[], policyBlocks[] }`。
- `formatRunTimeline` 输出行数组（每行一个事实），CLI 直接 `console.log`。

### 4.3 CLI（`scripts/replay-run.mjs`）

```
node scripts/replay-run.mjs --run-id <runId> [--data-dir <path>] [--json]
```
- 无事件：stderr 提示 + exit 2；缺 `--run-id`：用法 + exit 1。
- `package.json` 增 `"replay:run": "node scripts/replay-run.mjs"`。

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 快照噪声（机器/时间相关字段） | normalize 规则拍板 ③ 覆盖路径/平台/时间戳；场景 seed 全确定性；先在本地跑两遍验证幂等再提交 |
| 快照过拟合（合法重构被锁死） | 只锁发送面语义（messages/tools 键名），不锁内部日志、事件、计数器；每个场景配语义点断言定位 |
| 顺行/逆行的重构成本 | 重录入口唯一（`UPDATE_SNAPSHOTS=1`），失败信息自带命令 |
| reducer 与 journal 演进漂移 | 未知事件类型不炸（记 `unknownTypes`）；reducer 与事件同目录（`src/store/`），加事件时同提交补映射 |
| CLI 误读默认目录 | `--data-dir` 显式入参优先；无事件时给可操作的报错（检查目录与 runId） |

回滚：删除新增文件即回到现状，无运行时接线。

## 6. 测试策略

- **reducer 单测**：全事件类型各一 + 派生口径（settled/unsettled/unknown、durationMs、runId 过滤、未知类型收集）+ 格式化输出关键行 + 空输入。
- **快照测试**：本身即金标准；首录后人工 review 快照文件，再以「不改代码重跑绿」验证确定性。
- **CLI 冒烟**：临时 `APP_DATA_DIR` 写含全量事件的 journal，`execFileSync(process.execPath, [...])` 子进程跑 `scripts/replay-run.mjs`，断言文本行与 `--json` 结构（放在 reducer 单测文件末尾；脚本保持薄，解析/归约全在可单测模块里）。
- 全量 `npm test` 回归（基线 4025 + 本项新增）。

## 7. 实施状态

- [ ] `run-replay.logic.js` + 单测
- [ ] `scripts/replay-run.mjs` + `package.json` 脚本
- [ ] `run-openai.snapshot.test.js` + 快照文件（首录并 review）
- [ ] `src/store/CLAUDE.md` / `src/entrypoints/CLAUDE.md` / 报告 §14 状态同步
