# MCP 工具入参轻校验（JSON Schema 子集）· 设计

- 日期：2026-10-11
- 状态：已实现（与本文档一并提交）
- 关联：`src/providers/openai-compat-model.js` 的 `tool-call` 注释（2026-09-30 实测：AI SDK 只对 zod 形态的 inputSchema 校验，MCP 的 JSON Schema 参数类型不被校验，`Read` 的 `{path:123}` 直接放行）；T6 工具策略（审批面）之后的**执行面**兜底
- 范围：`src/providers/mcp.logic.js`（新，纯函数）、`src/providers/mcp.js`（`executeTool` 入口接线）、`src/providers/mcp.test.js`/`mcp.logic.test.js`、`src/providers/CLAUDE.md`、`openai-compat-model.js`（注释同步）

## 1. 背景与问题

- openai 路径的工具定义两种来源：内置/能力工具是 **zod** `inputSchema`（AI SDK 校验，坏参标 `invalid` 且不执行）；MCP 工具经 `@ai-sdk/mcp` 带来的是**原始 JSON Schema**（AI SDK 不校验——`client.tools()` 实测返回 `{ _type:'json', jsonSchema, validate }` 包装）。
- 后果：坏参**直达 MCP server**。server 不校验时可能执行脏副作用（如把 `{path:123}` 当文件路径用）；server 校验时也只回报含糊的协议错误，模型看不到「哪个字段错了」。
- Claude 路径不受影响（SDK 自己管 MCP 工具的校验），本项只补 openai 路径。

## 2. 目标与非目标

**目标**

1. **入口拦截**：`mcp.executeTool(name, input)` 在调用 server 前按该工具声明的 JSON Schema 做**确定性**校验；不通过 → 拒绝执行 + 抛出可读中文错误（agent-loop 会转成 tool-result 错误回灌，模型可修正重试）。
2. **宁漏勿误杀**：只判能静态确定的形状；判不了的（`anyOf`/`$ref` 等）整层跳过，交 server 兜底。规则误杀会破坏可用的 MCP 工具，比漏判更糟。
3. 零新依赖、纯函数可单测。

**非目标**

- 不做完整 JSON Schema 校验器（`format`/`pattern`/数值区间/`enum`/`additionalProperties` 不判）。
- 不改 AI SDK 的 `invalid` 通道（zod 路径现状不动）；不给 Claude 路径加校验。
- 不做「自动修复/强制转换」参数（拒绝即拒绝，修正交给模型）。

## 3. 拍板记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 模块形态 | `mcp.logic.js`（纯函数：`validateToolInput` + `unwrapJsonSchema`）；`mcp.js` 只管接线（与仓库 logic/runtime 分层一致） |
| 2 | 校验面 | `type`（含联合数组、integer/number 语义）、`required`、`properties`/`items` 递归；深度上限 8；错误截断 5 条 |
| 3 | 跳过语义 | 出现 `anyOf`/`oneOf`/`allOf`/`$ref`/`not`/`if` 的层级整体不判（含 required/递归）；非对象/布尔 schema 跳过；未知 type 放行 |
| 4 | required 作用域 | 只对对象值生效（JSON Schema 语义：非对象 → 关键字不适用，放行） |
| 5 | 包装拆解 | 连接时 `unwrapJsonSchema(t.inputSchema)` 取裸 schema 存内部表；`toolDefs` 仍存 AI SDK 原包装（streamText 需要） |
| 6 | 失败形态 | 抛 `Error('工具参数校验未通过（未执行）：…')`——与「未知 MCP 工具」同通道；agent-loop 捕获转 `{error}` 回灌。不返回伪成功、不静默 |
| 7 | 可观测性 | 拒绝时 `logger.warn('mcp', '工具入参未通过 schema 校验，已拒绝执行', {name, errors})` |

## 4. 测试

- `mcp.logic.test.js`（表驱动）：类型匹配放行（联合类型/integer/number/additionalProperties）；`{path:123}` 类型错；缺必填 + 嵌套/数组递归（顺序断言）；根级类型错不深入；跳过语义（anyOf/$ref/非对象值配 required）；错误截断 5 条；畸形 schema/深嵌套不炸。
- `mcp.test.js`（真实 echo server 集成）：`{text:123}` → rejects `/工具参数校验未通过（未执行）/`；`{}` → rejects `/缺少必填参数 text/`；正常 `{text:'hi'}` 不受影响。

## 5. 风险与回退

- 误杀面：server 的 schema 与实际接收行为不一致（声明 string 实收 number）时会被拒——这是 schema 撒谎，误杀方向正确且错误消息可读；若某 server 确实如此，可在 `validateToolInput` 的跳过集里按需扩展（退杀死角很小）。
- AI SDK 未来版本若自带 JSON Schema 校验，本层变冗余（不影响正确性）。
- 回退：删 `mcp.js` 中两行接线即可，纯增量无协议面影响。
