/**
 * 工具开关目录（纯数据 + 分叉函数）—— 🔧 工具弹层「内置工具」按 provider 展示真实可用的工具集。
 *
 * 为什么分叉：
 *  - Claude 路径（claude-agent SDK）：工具由 SDK 提供，禁用经 run-claude 的别名表归一
 *    （如 MultiEdit→Edit），此处 id 与 TOOL_DISABLE_ALIASES 的**逻辑名**一致；
 *    「问同事」两项走进程内 MCP（全名 `mcp__feishu-ask__X`），run-claude 已把它们也归一到这里
 *    的逻辑名，故开关同样生效（装配见 `capabilities/feishu-ask-sdk.js`）；
 *  - 自定义模型路径（openai-compat）：工具是本仓自研装配（`providers/builtin-tools.js` 六件套 +
 *    `providers/exec-sessions.js` 后台命令（P1-6：exec_command/write_stdin/list_processes/kill_process，一行开关管整族） +
 *    `capabilities/feishu-ask-tools.js` 委托同事 + 可选 RepoMap + 只读子代理 Task +
 *    Ultracode 的编排工具 Workflow + 子代理控制面（`capabilities/agent-registry.js`，
 *    P1-7：send_message/wait_agent/interrupt_agent/list_agents）），没有 Skills 机制。把 Claude 的清单拿来展示会误导用户：
 *    关了什么都没发生、真正存在的 Glob/RepoMap 又关不掉。
 *
 * disabledTools 是一份全局数组（uiPrefs.disabledTools），按**逻辑名**判：
 *  - Claude 路径经 run-claude 的别名表归一后匹配；
 *  - openai 路径由 `capabilities/tool-policy.logic.js#decideToolAction` 按工具名直接匹配。
 * 两边同名工具（Read/Write/Edit/Grep/Bash）共享开关，跨 provider 的 id 互不影响。
 */

/** Claude 路径的内置工具开关（与 run-claude.js TOOL_DISABLE_ALIASES 保持同一套逻辑名） */
export const CLAUDE_BUILTIN_TOOLS = Object.freeze([
  { id: 'Bash',      label: 'Bash',    desc: '执行终端命令' },
  { id: 'Write',     label: '写入',    desc: '创建/覆盖文件' },
  { id: 'Edit',      label: '编辑',    desc: '修改文件内容（含 MultiEdit）' },
  { id: 'Read',      label: '读取',    desc: '读取文件内容（含 NotebookRead）' },
  { id: 'Grep',      label: '搜索',    desc: '搜索文件（含 Glob / LS）' },
  { id: 'WebSearch', label: '网页搜索', desc: '搜索互联网' },
  { id: 'WebFetch',  label: '网页抓取', desc: '获取网页内容' },
  { id: 'Task',      label: '子代理',  desc: '启动子任务代理（含 Agent）' },
  { id: 'Workflow',  label: '工作流',  desc: '多智能体编排（ultracode 触发，可拉起多个子代理）' },
  { id: 'TodoWrite', label: '任务清单', desc: '管理待办清单' },
  { id: 'AskColleague',       label: '问同事',    desc: '委托同事对话：发卡片提问（进程内 MCP，需同事名册与飞书配置）' },
  { id: 'WaitColleagueReply', label: '等同事回复', desc: '等待「问同事」的结论（免审批）' },
]);

/** 自定义模型（openai-compat）路径真实装配的工具：builtin-tools 七件套 + 联网 + 子代理 + 委托同事 */
export const OPENAI_BUILTIN_TOOLS = Object.freeze([
  { id: 'Read',  label: 'Read',  desc: '读取文件/列目录（带行号，可分段读大文件）' },
  { id: 'Write', label: '写入',  desc: '创建或整体覆盖文件' },
  { id: 'Edit',  label: '编辑',  desc: '文件内精确字符串替换' },
  { id: 'Glob',  label: 'Glob',  desc: '按通配符查找文件路径（**、*、?、{a,b}）' },
  { id: 'Grep',  label: '搜索',  desc: '按正则搜索文件内容（文件:行号:内容）' },
  { id: 'Bash',  label: 'Bash',  desc: '在工作目录执行 shell 命令（测试/构建/git）' },
  { id: 'exec_command', label: '后台命令', desc: '启动长命令并轮询输出/写入输入（一行开关管 exec_command/write_stdin/list_processes/kill_process 整族）' },
  { id: 'RepoMap', label: '仓库地图', desc: '查询代码地图（git 仓库且「仓库地图」开启时可用）' },
  { id: 'WebFetch',  label: '网页抓取', desc: '抓网页转可读文本（网络类：询问档需审批，自动档放行）' },
  { id: 'WebSearch', label: '网页搜索', desc: '联网搜索（需在设置页「联网搜索」配置 API key；网络类审批）' },
  { id: 'TodoWrite', label: '任务清单', desc: '更新任务清单（显示在任务面板）' },
  { id: 'Task',      label: '子代理',  desc: '派只读子代理独立调查（不能写文件或执行命令）；带 background:true 则后台跑，结论用 wait_agent 取' },
  { id: 'send_message',    label: '给子代理发消息', desc: '向已派出的子代理追问/追加要求（它自己的探查历史还在）；关掉它，子代理的「后台派发」一并停用' },
  { id: 'wait_agent',      label: '等子代理',      desc: '等待一个子代理收尾并取回结论（默认 30s，超时如实返回「仍在运行」）' },
  { id: 'interrupt_agent', label: '中断子代理',    desc: '掐断一个正在跑的子代理（历史与未读消息保留，可再让它继续）' },
  { id: 'list_agents',     label: '子代理清单',    desc: '列出本轮派过哪些子代理：状态/耗时/轮数/token/结论摘要' },
  { id: 'Workflow',  label: '工作流',  desc: '多智能体编排（Ultracode 档触发，并行拉起多个只读子代理；成倍消耗额度）' },
  { id: 'AskColleague',       label: '问同事',    desc: '委托同事对话：发卡片提问（需同事名册与飞书配置）' },
  { id: 'WaitColleagueReply', label: '等同事回复', desc: '等待「问同事」的结论（免审批）' },
]);

/** 当前 provider 的工具清单（未知 provider 按 Claude 处理，与 chat.js 的缺省分支一致） */
export function builtinToolsFor(provider) {
  return provider === 'openai-compat' ? OPENAI_BUILTIN_TOOLS : CLAUDE_BUILTIN_TOOLS;
}
