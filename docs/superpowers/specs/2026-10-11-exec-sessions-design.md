# 命令会话管理器（P1-6 · exec sessions）· 设计

- 日期：2026-10-11
- 状态：已实现（与本文档一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §8「可借鉴 P1-①/②」（原文：会话化执行 `exec_command`/`write_stdin`、头尾双保留 + 省略标记、并发上限 + run 结束 `terminateAll`、工具面 `exec_command`/`write_stdin`/`list_processes`/`kill_process`、YIELD 默认 10s）；上游依赖 T6 执行后端（`exec-backends.js`，local/container/unavailable 语义）、Bash 工具（kill 树 + abort 先例）、T2-P4 工具策略表
- 范围：`src/providers/exec-sessions.js`（新，运行时）、`src/providers/exec-sessions.logic.js`（新，纯函数）、`src/providers/exec-backends.js`（`killTree` 收编为共享）、`src/entrypoints/web/run-openai.js`（装配 + 收尾）、`src/capabilities/tool-policy.logic.js`（`session` 类）、`src/entrypoints/web/tool-summary.js`（审批卡文案）、`public/js/tool-list.logic.js`（开关行）。**Claude 路径不动**（SDK 自带 Bash，无会话需求）。

## 1. 背景与问题

- 现状：Bash 工具**一次调用等到底**（默认 120s / 上限 600s），到点强杀。`npm run dev`、长构建、跑测试只能「等或杀」——agent 拿不到「先跑起来、过一会儿看输出」的能力，长任务只能串行猜时间。
- Codex 的对照（`core/src/unified_exec`）：`exec_command` 启动进程并最多等一个 yield 时间片（250ms–30s，默认 10s），未结束返回 `process_id`；`write_stdin` 继续轮询/写入；输出头尾双保留 + 省略标记；并发上限 64、单次输出 1MiB、流式增量 ≤ 8KB。
- 本仓库的现成基建：`makeBashSpawn`（local/container/unavailable 三种后端）、`killTree`（Windows taskkill /T）、run 级 abort 信号——缺的只是「进程登记表 + 输出缓冲 + 轮询语义」。
- 工具去重：Bash 保留原语义（fire-and-wait），exec 会话族是新能力（start + poll）；两者共用同一策略表与审批卡。

## 2. 目标与非目标

**目标**

1. **进程会话**：`exec_command` 启动命令，最多等 `yield_ms`（默认 10s、上限 30s）；超时未结束返回会话 id，进程继续跑，输出留存待轮询。
2. **轮询/写入**：`write_stdin` 读取未消费输出（单次 ≤ 8KB），可顺带写 stdin；进程退出后仍可读收尾输出与退出码。
3. **会话管理**：`list_processes`（列表 + 状态 + 未读字节）、`kill_process`（杀进程树，等 close 回报）。
4. **输出纪律**：头尾双保留（头 16K + 尾 112K 字）+ 中段省略标记；**run 结束（正常/失败/停止）一律 `terminateAll`**，不留孤儿进程。
5. **策略对齐**：`exec_command` 走 execute 类（危险命令 deny、无人值守安全命令表照常）；会话控制类工具只操作本 run 自建进程，默认档不反复打断用户；`write_stdin` 写入内容命中危险名单时降级为「确认」。

**非目标**

- **不做交互式 shell**：会话是「单条命令的进程」，不是 REPL；写 stdin 面向前述进程的提示应答。
- **不做 exec-server / JSON-RPC 服务化**（报告 §8 P2-③，明确推后）；沿用 docker/podman backend。
- **不给 Claude 路径加**：SDK 有自己的 Bash；`steerMode` 级的能力分叉不引入第二处。
- **不做跨 run 会话**：会话属 run（实例随 run 创建/销毁），`/api/run/*` 不暴露进程操作端点。
- **不做 UI 面板**：进程状态经工具结果 + 活动行可见；不做独立进程面板。

## 3. 拍板记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 模块形态 | `exec-sessions.logic.js`（纯函数：缓冲/格式化/夹取，零 IO）+ `exec-sessions.js`（运行时：spawn/登记表/terminateAll）。与 `exec-backends` 同款分层。 |
| 2 | 装配点 | 独立工厂 `createExecSessions({ cwd, signal, bashBackend, onActivity? })`，run-openai 按 `createWebTools` 同款装配进 `localDefs`/`executeTool`；**不进 `builtin-tools.js` 的恒有七件套**（llm-openai-agent 等辅助通道不受影响）。 |
| 3 | 工具名/入参 | Codex 形态：`exec_command({command, yield_ms?})`、`write_stdin({process_id, chars?, yield_ms?})`、`list_processes({})`、`kill_process({process_id})`。session id 为 per-run 递增整数（`#1`、`#2`…），只在本 run 会话表内可寻址。 |
| 4 | 输出缓冲 | 单缓冲（stdout+stderr 按到达序合并，终端观感）；头 16K + 尾 112K 字双保留，中段溢出累计为省略计数、在下一次读取时以「…（中间省略 N 字）…」报告；`StringDecoder` 处理 chunk 边界的多字节字符。 |
| 5 | 读取语义 | 消费式（读走即清）；单次 ≤ 8KB 字，剩余提示「还有 N 字未读，再次 write_stdin 续读」；进程退出后的剩余输出照常可读。 |
| 6 | yield 取值 | `exec_command` 默认 10s、范围 250ms–30s；`write_stdin` 默认 5s、同范围（纯轮询不该等满 10s）。 |
| 7 | 进程上限 | 每 run ≤ 8 个会话；满了先回收**已退出**的最旧会话，仍满则明确报错（提示先 kill/list）。已退出的会话保留输出直到 run 结束或被回收。 |
| 8 | 收尾纪律 | run 的 `finally` 调 `terminateAll()`（幂等）；abort 信号监听同样走 `terminateAll`（用户点停止 → 秒杀所有会话）。kill 用共享 `killTree`（Windows taskkill /T）。 |
| 9 | 策略分类 | 新增 `session` 类：`write_stdin`/`kill_process`/`list_processes` 只操作本 run 会话表（拿不到任意进程句柄），除 `plan` 档（无会话可操作，沿 deny 语义）外放行；`write_stdin` 的 `chars` 命中危险命令名单时降级为 `ask`（宁问勿放）。`exec_command` 归入 `EXEC_TOOLS`（与 Bash 同一裁决路径：危险 deny / 安全表 / 档位）。 |
| 10 | 开关与禁用 | UI 工具目录新增一行 `exec_command`（「后台命令」）；run-openai 的 disabled 展开：禁用 `exec_command` 时把会话族四个名字一并加入禁用集（单行开关覆盖整族）。 |
| 11 | 审批卡文案 | `summarizeTool` 增四例：`exec_command` → 「执行（后台）…」、`write_stdin` → 「轮询/写入进程 #N」、`kill_process` → 「结束进程 #N」、`list_processes` → 「列出后台命令」。活动行同源。 |
| 12 | 系统提示 | `buildAgentSystemPrompt` **不改成全局**（辅助通道没有这些工具）；`exec-sessions.js` 导出 `buildExecSessionsPrompt()` 片段，run-openai 在 system 拼装处追加。 |

## 4. 设计

### 4.1 纯函数层（`exec-sessions.logic.js`）

```js
export const SESSIONS = { DEFAULT_YIELD_MS: 10_000, WRITE_DEFAULT_YIELD_MS: 5_000,
  MIN_YIELD_MS: 250, MAX_YIELD_MS: 30_000, READ_CAP_CHARS: 8_000,
  HEAD_KEEP_CHARS: 16_000, TAIL_KEEP_CHARS: 112_000, MAX_SESSIONS: 8, EXIT_GRACE_MS: 100 };

createBuffer() -> { text: '', dropped: 0 }
bufferAppend(state, chunk)   // 追加 + 超限剪中段（保留头尾，dropped 累计）
bufferDrain(state, cap)      // -> { text, remaining }（省略标记前置；remaining>0 时附续读提示）
clampYieldMs(v, fallback)    // 非法/缺失回退；夹到 [MIN, MAX]
formatSessionHeader(id, status, extra)  // 【进程 #N · 运行中/已退出（码 X）/已终止】
formatExecStart({...}) / formatWriteResult({...}) / formatListResult(sessions) / formatKillResult({...})
buildExecSessionsPrompt()    // system 片段
```

### 4.2 运行时（`exec-sessions.js`）

```js
createExecSessions({ cwd, signal, bashBackend }) ->
  { toolDefs, executeTool, terminateAll, list, size }
```

- `exec_command`：`spawn(plan.bin, plan.args, { shell, cwd, windowsHide, env })`（plan 来自共享 `makeBashSpawn`）；登记会话；`await` 竞速（退出 / `clampYieldMs` / abort）；退出或超时后 `bufferDrain` 出格式化结果。
- `write_stdin`：定位会话（失联给回收文案）；有 `chars` 则 `child.stdin.write`（stdin 出错不影响读）；等 yield（同竞速）后 drain。
- 退出检测：`close` → 标记 exited（记退出码/耗时）；`exit` + `EXIT_GRACE_MS` 兜底（孙进程持管道时 close 可能不来）→ 同样标记。
- `kill_process`：`killTree` → 等 close（2s 兜底）→ 标记 killed + drain 收尾输出。
- 上限：新会话前若满 8，先回收最旧「已退出」会话；全在跑 → 拒绝文案。
- `terminateAll()`：杀所有活动子进程、幂等；`signal` abort 时自动调用一次。
- `bashBackend.kind === 'unavailable'` → `exec_command` 明确报错（fail-closed 不静默回本地）；container 后端逐字复用 `makeBashSpawn` 的 `docker run` 计划（stdin 用 `-i` 已具备）。

### 4.3 策略与装配

- `tool-policy.logic.js`：`SESSION_TOOLS` 集合 + `classifyTool` 返回 `'session'`；`decideToolAction` 分支：`caps.other === 'deny' ? deny : allow`（plan deny / 其余 allow），`write_stdin` 先跑 `detectDangerousCommand(input?.chars)` → 命中则 `ask`（plan 仍 deny）。
- `run-openai.js`：
  - `const sessions = createExecSessions({ cwd: workspace, signal: run.abortController.signal, bashBackend });`
  - `localDefs` 合并 `sessions.toolDefs`；`executeTool` 路由加一行；
  - disabled 展开：`if (disabledToolsSet.has('exec_command')) for (const n of EXEC_SESSION_TOOL_NAMES) disabledToolsSet.add(n);`
  - system 拼装追加 `buildExecSessionsPrompt()`；
  - `.finally` 增 `sessions.terminateAll();`（与 `mcp.close()` 并列）。
- `tool-summary.js`：四例文案（见拍板 11）。
- `public/js/tool-list.logic.js`：`OPENAI_BUILTIN_TOOLS` 增 `{ id:'exec_command', label:'后台命令', desc:'启动长命令并轮询输出/输入（含 write_stdin / list_processes / kill_process）' }`。

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 孤儿进程（模型开了不关） | run `finally` + abort 双保险 `terminateAll`；会话表 per-run 不跨 run |
| 输出爆量撑 context | 单次读 ≤ 8KB；缓冲头尾双保留 128K 上限；省略标记显式报告丢弃 |
| stdin 绕过危险命令名单 | `write_stdin` 的 `chars` 过危险名单 → 降级 `ask`；会话只能从已审批的 `exec_command` 获得 |
| 交互式 shell 被当会话跑 | 允许（用户审批时看到的就是 shell 命令）；stdin 危险输入仍有一层确认 |
| 并发进程拖垮机器 | 每 run ≤ 8；满了回收已退出会话或明确报错；用户停止 run 秒杀全部 |
| container 后端语义差异 | 复用既有 `makeBashSpawn`（`-i` 已在）：stdin/轮询经 docker 转发，逐字同 Bash 的隔离承诺 |
| 辅助通道（llm-openai-agent）误得新工具 | 该通道按 `READONLY/WRITE/FULL_TOOL_NAMES` 白名单挑选，会话族不在任何名单内 |

回滚：删 `localDefs` 合并行 + `finally` 清理行即回到「只有 Bash」；`exec-sessions.js` 工厂与策略 `session` 类是纯增量，无存量依赖。

## 6. 测试策略

- `exec-sessions.logic.test.js`：缓冲追加/中段剪除/省略标记/消费式读取上限与续读提示/`clampYieldMs` 夹取/各格式化函数文案（含无输出、已退出、回收）。
- `exec-sessions.test.js`（真 spawn，node 脚本夹具，同 `builtin-tools.test.js` 风格）：快速命令即退（含退出码）；长进程超时返回 `#N` + 后续 `write_stdin` 增量读到标记行；stdin 回显（脚本 readline）；`kill_process` 终止；`list_processes` 状态；上限拒绝/回收；`terminateAll` 幂等；abort 信号杀会话；`unavailable` 后端报错；失联会话 id 的文案。
- `tool-policy.logic.test.js`：`exec_command` 危险命令 deny / 安全命令在 unattended-standard 放行 / default ask；会话控制类 default allow、plan deny；`write_stdin` 危险 `chars` → ask。
- `tool-summary.test.js`：四例文案。
- `run-openai` 侧：快照测试 s1–s5 的 `tools` 数组与 system 片段随新装配更新（重录并人工核对只增不改）；`tool-list.logic.test.js` 断言新行。
- 全量回归 + CI e2e 子集（openai-resume / openai-retry）守绿。

## 7. 实施状态

- [x] `exec-sessions.logic.js` + 单测
- [x] `exec-sessions.js`（spawn/登记/terminateAll）+ 单测
- [x] `exec-backends.js#killTree` 共享化（builtin-tools 改用共享实现）
- [x] `tool-policy.logic.js` `session` 类 + 单测
- [x] `tool-summary.js` 四例 + 单测
- [x] `run-openai.js` 装配/收尾/禁用展开/system 片段
- [x] `public/js/tool-list.logic.js` 开关行 + 单测
- [x] 快照重录（人工核对）＋ CLAUDE.md / 报告 §8/§14 状态同步
