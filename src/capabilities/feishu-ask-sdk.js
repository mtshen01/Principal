/**
 * 「委托同事对话」工具的 **Claude Agent SDK 版**：把 `feishu-ask-tools.js` 的两个工具
 * （AskColleague / WaitColleagueReply）包成一个进程内 MCP server，供 `run-claude.js` 注入。
 *
 * 为什么不复用 `agent-tools.js` 的注册表：那套是「同事对话 agent」用来跟同事聊天的工具
 * （`registerAgentTool`，带 role 过滤与撤销台账），与主 agent 的委托工具语义不同、消费方也不同。
 * 硬塞进同一份注册表会把两条链路耦在一起。
 *
 * 工具全名 = `mcp__<SERVER>__<tool>`（SDK 约定）：AskColleague 落策略门 `other` 档（默认「询问」
 * 走审批卡、bypass 放行）；WaitColleagueReply 只是等时间、无副作用 → 进 `FEISHU_ASK_SDK_READONLY`
 * 免审批。**必须用全名**（策略门是 `Set.has(name)` 精确匹配）。
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createFeishuAskTools, FEISHU_ASK_TOOL_NAMES } from './feishu-ask-tools.js';

/** MCP server 名。工具全名是 `mcp__feishu-ask__<name>` */
export const FEISHU_ASK_SDK_SERVER = 'feishu-ask';

/** 免审批工具全名集合（等待无副作用）。调用方接进策略门的 readOnlyExtra */
export const FEISHU_ASK_SDK_READONLY = new Set([`mcp__${FEISHU_ASK_SDK_SERVER}__WaitColleagueReply`]);

/**
 * 策略门别名表：MCP 工具**全名** → 逻辑名（`mcp__feishu-ask__AskColleague` → `AskColleague`）。
 * 让右下角工具列表的开关（disabledTools 按逻辑名存）能管到这两个 MCP 工具；从
 * FEISHU_ASK_TOOL_NAMES 派生，新增工具自动获得开关，不手抄第二份清单。
 */
export const FEISHU_ASK_SDK_ALIASES = Object.freeze(
  Object.fromEntries(FEISHU_ASK_TOOL_NAMES.map((n) => [`mcp__${FEISHU_ASK_SDK_SERVER}__${n}`, n])),
);

const textResult = (s) => ({ content: [{ type: 'text', text: String(s ?? '') }] });

/**
 * 造一个绑定到某次 run 的 feishu-ask MCP server。
 * @param {{runId?:string, convId?:string, signal?:AbortSignal, pulse?:Function, activity?:Function}} [ctx]
 * @returns {{server:object, readOnly:Set<string>}}
 */
export function buildFeishuAskMcpServer({ runId = null, convId = null, signal, pulse, activity } = {}) {
  const { toolDefs, executeTool } = createFeishuAskTools({ runId, convId, signal, pulse, activity });
  // feishu-ask-tools 的 inputSchema 是 zod object（openai 路径要整对象做校验）；
  // SDK 的 tool() 要的是 raw shape —— 取 .shape 即可，两处共用同一份字段定义。
  const defs = Object.entries(toolDefs).map(([name, def]) =>
    tool(name, def.description, def.inputSchema.shape, async (input) => textResult(await executeTool(name, input))),
  );
  const server = createSdkMcpServer({
    name: FEISHU_ASK_SDK_SERVER,
    version: '1.0.0',
    instructions: '委托同事对话：AskColleague 发飞书卡片提问（非阻塞），WaitColleagueReply 等结论。',
    tools: defs,
    alwaysLoad: true,
  });
  return { server, readOnly: FEISHU_ASK_SDK_READONLY };
}
