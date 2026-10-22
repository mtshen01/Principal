# 自定义模型的 Ultracode（内置多智能体编排）· 设计

- 日期：2026-10-08
- 状态：已实现（用户点单：「自定义模型能开发支持 Ultracode 模式吗?」）
- 前置：`2026-09-02-workflow-ultracode-design.md`（Claude 路径：关键字触发 CLI 自带的 Workflow 工具）
- 关联：`src/capabilities/workflow.logic.js`(+test)、`src/entrypoints/web/{run-openai.js,routes-run.js,conv-inbox.js,tool-summary.js}`、`src/store/runs.js`、`public/js/{effort.logic.js,chat.js,tool-list.logic.js,ultracode.logic.js}`、`tests/e2e-ultracode-custom.mjs`、`src/entrypoints/web/run-openai.workflow.test.js`

## 1. 问题

Claude 路径的 Ultracode = 给 prompt 拼 `ultracode ` 关键字，让 **CLI 自带的 `Workflow` 工具**（脚本里 `agent()/parallel()/phase()`）跑多智能体编排。自定义模型（openai-compat）走的是本仓自研 agent-loop，没有那个工具 —— 所以此前该档对自定义模型**整档不可达**（`effortOptions` 不返回它、`syncEffortUI` 里 `!isCustom` 熄灭、`ensureEffortValid` 强制关编排）。

用户问「能不能支持」。答案：**能，但不能只拼关键字** —— 得在 openai 路径上实现等价能力（编排器 + 子代理 + 进度 + 汇总）。

## 2. 与 CLI 版的刻意差异（两个）

| 维度 | Claude（CLI Workflow） | 自定义模型（本设计） |
|---|---|---|
| 入参 | JS 脚本（`agent()/parallel()/pipeline()/phase()`） | **结构化的阶段/子任务 JSON**（`name/goal/phases[].tasks[].prompt`）。脚本契约是 CLI 的运行时，我们没有；且模型产出符合 zod schema 的 JSON 远比产出「符合一个我们没实现 API 的脚本」可靠 |
| 触发 | prompt 里的 `ultracode` 关键字（CLI 原生触发） | **服务端授权位**：`/api/run/start` 带 `ultracode:true`，该 run 才注入 `Workflow` 工具 + 系统提示里的授权说明。关键字对别家模型是暗号，拼了只会让模型困惑 |
| 子代理能力 | CLI 自行决定（含写） | 沿用本仓**只读子代理**口径（Read/Glob/Grep/WebFetch/WebSearch/RepoMap）。改动逐个走审批，放进并行子代理里没人看着 —— 风险与收益不匹配；编排负责并行调研，改动与交付由主模型自己做 |

## 3. 数据流

```
强度滑条 ✨档（自定义模型也可选）→ chatUltracode=true（会话级）
   └─ 工具列表「工作流」被禁用时该档 blocked（canEnableUltracode，两家同一判据）
用户发送 → POST /api/run/start { provider:'openai-compat', ultracode:true, effort:<厂商档位>, ... }
   └─ startOpenAiRun：run.ultracode = true（进 run-index / submitted 事件，续跑与排队快照都不丢）
        └─ runOpenAiSession：
             ├─ ultracode = run.ultracode && !disabledTools.has('Workflow')
             ├─ 系统提示末尾追加 buildUltracodeAuthPrompt()（只在这一轮）
             └─ localDefs 注入 Workflow: WORKFLOW_TOOL_DEF
模型决定调用 Workflow
   └─ executeTool('Workflow') → ultracode ? runWorkflow(input) : fail-closed 明确拒绝
        ├─ normalizeWorkflowSpec：归一 + 上限截断（4 阶段 / 每阶段 6 / 合计 12 / prompt 4000 字）
        ├─ runWorkflowPlan：逐阶段推进，阶段内并发 ≤3，跑只读子代理（真 agent-loop 嵌套）
        │    └─ 进度 → runActivity：`⚡ 工作流(x) · 2 阶段/5 子任务 启动` / `✔ 子任务 1/2「…」完成` / …
        └─ mergeWorkflowResults：阶段→子任务结论汇总（单条 2k / 总计 12k 截断）→ 回主模型
主模型拿到汇总 → 对用户做最终总结（工具结果里明确要求「有失败或缺口要如实说明」）
```

## 4. 设计要点

### 4.1 授权位而不是关键字

- **额度可控**：不开编排时 `Workflow` 工具**根本不存在**，模型不可能自发并行起十几个子代理。这与 CLI 侧「额度不可控的工具必须由用户显式授权」是同一条原则。
- **可观测**：服务端日志/索引/事件流里都有 `ultracode` 字段（此前只能从 prompt 里看到关键字）。
- **fail-closed 双闸**：① 没授权就不注入工具定义；② `executeTool` 里再判一次（`本轮未开启 Ultracode，工作流不可用`）。第二道闸不是多余的 —— 假 provider/异常路径下工具名仍可能到达执行体，而这条直接决定花多少钱。

### 4.2 规模上限（写死在纯逻辑层）

| 项 | 上限 | 理由 |
|---|---|---|
| 阶段数 | 4 | 再多也不是「并行调研」，是失控 |
| 每阶段子任务 | 6 | 阶段内并发 3，再多只是排队烧额度 |
| 合计子任务 | 12 | 一轮编排的成本上限 |
| 单任务 prompt | 4000 字 | 模型自拟，长度无约束 |
| 阶段内并发 | 3 | 再高只把同一份额度烧得更快，活动转录也没法读 |
| 回传主模型 | 单条 2k / 总计 12k 字 | 汇总进主模型上下文 = 进主会话窗口，12 个子任务全文会直接把窗口吃掉 |

超限一律**截断并记账**（`plan.truncated`），不整轮失败：已经开跑的一轮不该因为阶段写多了就只剩一句报错。

### 4.3 失败与中断

- 子任务抛错 → 记失败项（`❌ 子任务失败：<msg>`），**编排继续**；主模型看到缺口才会如实告诉用户。
- abort（用户点停止）→ 不再起新阶段/新子任务，结果带「本轮被用户中断」标记。
- 子任务工具审批复用主 run 的策略门：网络类照常在询问档弹卡。

### 4.4 前端

- `effortOptions`：自定义模型 = `[none?, ...厂商档, Ultracode]`。**没有 effort 元数据的模型也给 Ultracode**（它是编排开关，不是厂商档位）——否则这类模型永远够不到编排；此时 chip 显示「强度 · 默认」。
- `pickEffort` 永不返回 `ULTRACODE`（否则会被当 `reasoning_effort` 发给服务商）；落档时自定义模型**保持**用户选的厂商档位（各家档位语义自拟，硬映射到某一档是猜）。
- 工具列表 `OPENAI_BUILTIN_TOOLS` 增「工作流」行：用户能像别的工具一样关掉它（关掉后 ✨ 档 blocked 并 toast 解释）。
- `decorateUltracode` 对 openai 仍不加前缀（关键字只进 Claude），注释改写为「两条触发路径」。

### 4.5 续跑 / 排队

`run.ultracode` 进 run-index 与 `submitted` 事件；`buildFollowUpItem` 快照带上它（排空起新 run 不丢授权）；`resumeOpenAiRun` 从索引恢复（历史里可能已有 Workflow 的调用与结果）。`conv-inbox` 取「排空时刻原 run 的最新值」优先，回落排队快照 —— 与 `mode` 同一套口径。

## 5. 测试

| 文件 | 覆盖 |
|---|---|
| `src/capabilities/workflow.logic.test.js` | 归一（宽松字段/空白 prompt 跳过/无可用阶段报错）、三处上限截断、并发池（顺序/并发峰值/结果顺序）、失败不中断、abort、汇总裁剪与失败标记、工具 schema 正反例、授权说明要点 |
| `src/entrypoints/web/run-openai.workflow.test.js` | 入口级集成（注册表覆盖假 provider + 真 agent-loop）：授权位决定工具是否存在、三个只读子代理并行（峰值≥2）且不带写/命令/递归工具、进度进活动转录、汇总回主模型、未授权时硬调 fail-closed 不起子代理、工具被禁用时退回普通路径并明确告知 |
| `public/js/effort.logic.test.js` | 自定义档位含 Ultracode、`pickEffort` 永不返回 Ultracode、`ultracodeBlocked` |
| `public/js/tool-list.logic.test.js` | openai 清单含 Workflow（且与真实装配一致） |
| `tests/e2e-ultracode-custom.mjs` | 真前端 + 桩网络：✨ 档可达、chip/流光、工具列表有「工作流」行、**发送体带 `ultracode:true` 且 effort 仍是厂商档位**、无 pageerror |

`npm test` 3789 全绿；`npm run test:e2e` 14/14。

## 6. 不做的事（YAGNI）

- 工作流专用进度面板（活动转录够用；真要面板再谈）。
- 编排的预算上限（轮次/金额）与并发可配：先观察真实用量。
- 子代理写权限：见 §2 的取舍，要开放得先解决「并行写 + 审批」的交互模型。
- 飞书 / 无人值守渠道的 Ultracode 触发：本期只做 web 交互路径。

## 7. 风险

- **额度**：一轮编排最坏 12 个子代理 × 各自最多 `openaiMaxSteps` 步。上限已写死在纯逻辑层并单测覆盖；用户还能在工具列表里整体关掉「工作流」。
- **模型不按 schema 调用**：AI SDK 会校验 zod 并在不匹配时标 `invalid`（不执行、回灌错误让其修正）；`normalizeWorkflowSpec` 再兜一层（空/坏形状返回可读错误）。
- **自拟 prompt 质量**：子代理看不到主会话历史，工具描述里已明确要求 prompt 自包含；质量仍取决于模型，故汇总里保留了「有缺口要如实说明」的硬要求。
