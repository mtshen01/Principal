/** web 入口：openai-compat run 编排（历史走 conv-messages 重放，发送面必过 capabilities/context-normalize；T2-P3 起每步落盘为检查点，崩溃后从检查点续；P5 起孤儿对账统一走 run-claude.js#reconcileRuns） */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../shared/logger.js';
import * as providers from '../../providers/index.js';
import { getMessages, appendMessages, getSummary, setSummary } from '../../store/conv-messages.js';
import {
  COMPACT_TRIGGER,
  shouldCompact,
  pickCompactCut,
  resolveKeepRecent,
  formatMessagesForSummary,
  buildSummaryPrompt,
  normalizeSummaryText,
  composeSystemWithSummary,
  SUMMARY_SYSTEM_PROMPT,
} from './conv-compact.logic.js';
import { contextTokenStatus } from '../../capabilities/context-budget.logic.js';
import { normalizeForModel } from '../../capabilities/context-normalize.logic.js';
import { describeRetryKind, formatRetryDelay } from '../../providers/model-retry.logic.js';
import { connectMcpServers, buildAutoAllowSet } from '../../providers/mcp.js';
import {
  createRun,
  runPulse,
  runText,
  runActivity,
  runResult,
  runTodos,
  runUsage,
  finishRun,
  failRun,
  askUser,
  nextReqId,
  emitRunEvent,
  truncateForJournal,
  hydrateRunTodos,
  consumeHeldMsgs,
} from '../../store/runs.js';
import { upsertRun, removeRun } from '../../store/run-index.js';
import { getConvTodos, renderPlanSection } from '../../store/conv-todos.js';
import { resolveMaxSteps } from './run-openai.logic.js';
import { getMcpServers, getBuiltinMcp, getRepoMapSettings, getUiPrefs, getExecSettings, getSearchSettings, credentialModels } from '../../store/settings.js';
import { pickActive, getTokens, getTokenById } from '../../capabilities/token-rotation.js';
import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';
import { summarizeTool } from './tool-summary.js';
import { createBuiltinTools, buildAgentSystemPrompt, normalizeTodos } from '../../providers/builtin-tools.js';
import { createExecSessions, EXEC_SESSION_TOOL_NAMES, buildExecSessionsPrompt } from '../../providers/exec-sessions.js';
import { resolveBashBackend, describeBackend } from '../../providers/exec-backends.js';
import { createFeishuAskTools, FEISHU_ASK_READONLY_TOOLS } from '../../capabilities/feishu-ask-tools.js';
import { createPolicyGate } from '../../capabilities/tool-policy.js';
import { createWebTools } from '../../capabilities/web-tools.js';
import { clipText } from '../../capabilities/web-tools.logic.js';
import { pickReadonlyToolDefs, buildSubagentSystemPrompt, SUBAGENT_TOOL_DEF } from '../../capabilities/subagent.logic.js';
import { createAgentRegistry, AGENT_TOOL_NAMES } from '../../capabilities/agent-registry.js';
import { resolveBuiltinMcp } from '../../capabilities/builtin-mcp.js';
import {
  normalizeWorkflowSpec,
  runWorkflowPlan,
  mergeWorkflowResults,
  workflowLabel,
  buildUltracodeAuthPrompt,
  WORKFLOW_TOOL_DEF,
} from '../../capabilities/workflow.logic.js';
import { getRepoMap, TOOL_BUDGET_CHARS } from '../../features/repo-map/index.js';
import { normalizeAttachments, inlineImageAttachments } from '../../capabilities/image-attachments.logic.js';

/**
 * run 收尾时等后台子代理（P1-7）的上限：等不住就 abort 并在活动行如实告知。
 * 为什么不无限等：一个后台子代理不该拖住整个 run 的收尾；为什么不等也不行：run 都结束了，
 * 它的结论没有任何出口，只会白烧额度（docs/superpowers/specs/2026-10-16-agent-registry-and-handles-design.md §7.3）。
 */
const BACKGROUND_SETTLE_MS = 60_000;

/**
 * 定位本轮该用哪条 openai-compat 凭证。
 *
 * 之所以不能只靠 pickActive：它返回的是「第一条可用的 openai-compat 凭证」，
 * 而 model 由前端按用户点的 pill 单独传入。两者来源不同 → 多厂商共存必然串台：
 * 点智谱发出 model=glm-4，却配上 DeepSeek 的 apiKey/baseURL，
 * 请求打到 api.deepseek.com 去要一个 glm-4，必然 400。
 *
 * 优先级：credId 精确命中 > 按 model 匹配（老前端不传 credId）> pickActive 兜底。
 * 中间那层是关键的向后兼容：老会话虽没有 credId，但 model 已经能把厂商区分开，
 * 直接掉到 pickActive 等于放任串台。
 *
 * @returns {{cred: object|null, reason: string}} reason 供日志追溯实际走了哪条路径
 */
export function resolveCredential(tokens, { credId, model }) {
  const list = (Array.isArray(tokens) ? tokens : []).filter(
    (t) => t && (t.providerId || DEFAULT_PROVIDER_ID) === 'openai-compat',
  );
  if (credId) {
    const hit = list.find((t) => t.id === credId);
    if (hit) return { cred: hit, reason: 'by-id' };
    // 指名的凭证没了（设置页刚删/导入了别的配置）：不静默换一条别的号去发，
    // 让它落到下面的 model 匹配，匹配不上就报错——用错凭证比失败更难排查。
  }
  if (model) {
    // 凭证多模型（OpenCode 式）：按凭证发现到的模型列表匹配；legacy 单 model 由 credentialModels 归一
    const byModel = list.filter((t) => credentialModels(t).some((m) => m.id === model));
    // 仅在**唯一**命中时才认：同 model 多条（同厂商不同 key）无从判断用哪条，
    // 挑一条等于赌，交给 pickActive 的确定性顺序更诚实
    if (byModel.length === 1) return { cred: byModel[0], reason: 'by-model' };
  }
  const active = pickActive(list, 'openai-compat');
  return { cred: active, reason: active ? 'fallback-active' : 'none' };
}

/** 本轮实际模型：请求指定优先；缺省回落凭证发现到的第一个（legacy model 已由 credentialModels 归一） */
function pickModel(model, cred) {
  return model || credentialModels(cred)[0]?.id || '';
}

/**
 * 载入 conv-messages 并跑发送前不变量（P0-③ normalize，见 capabilities/context-normalize.logic.js）：
 * 悬空 tool-call 补合成「未执行」结果、孤立 tool 结果剔除、空 assistant 消息剪除、超长单条中间截断。
 * 合成结果必须**落盘**（否则存储永远缺这条、新消息接在断口后）；剔除/前拉/剪空/截断只作用于本次视图
 * ——存储是全量账本，发送面（含压缩的 covered 索引）全部按本函数返回的视图计算。
 */
function loadNormalizedHistory(run, convId) {
  const { messages, added, stats } = normalizeForModel(getMessages(convId));
  if (added.length && convId) {
    appendMessages(convId, added);
    runActivity(run, `⚠️ 检测到 ${added.length} 个中断未执行的工具调用，已按「未执行」补记`);
  }
  if (stats.droppedOrphans || stats.moved || stats.droppedEmpty || stats.trimmed) {
    logger.info('web', '发送前 normalize 修正了历史序列', { runId: run.id, convId: convId || null, ...stats });
  }
  return messages;
}

/** 被丢段 → 摘要文本（同会话凭证一次性无工具调用；零工具时 agent-loop 自然降级纯对话） */
async function summarizeSpan({ run, cred, model, previousSummary, dropped }) {
  const prompt = buildSummaryPrompt({ previousSummary, droppedText: formatMessagesForSummary(dropped) });
  let text = '';
  const handle = providers.get('openai-compat').run(
    {
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      model: pickModel(model, cred),
      apiKey: cred.token,
      baseURL: cred.baseURL,
      abortController: run.abortController,
    },
    { onText: (t) => (text += t) },
  );
  await handle.done;
  const out = normalizeSummaryText(text);
  if (!out) throw new Error('摘要调用返回空文本');
  return out;
}

/**
 * 压缩编排（T7 §4.3；P0 双触发）：模型可见视角接近上限——条数 > COMPACT_TRIGGER，或估算 token
 * 达窗口 90%（判定在 capabilities/context-budget.logic#contextTokenStatus）——则生成滚动摘要并落盘，
 * 返回当前有效摘要（或原样）。窗口未知时只保留条数口径（分母绝不猜）。
 * 保留窗口 token 感知：尾部消息过重会收缩（resolveKeepRecent），防「压缩完模型视角仍然超窗」。
 * fail-open：摘要失败只提示、不阻塞——本轮按原文继续（与改动前行为一致），下轮再试。
 */
async function maybeCompactHistory({ run, cred, model, convId, messages, windowTokens = null }) {
  if (!convId) return null;
  let summary = getSummary(convId);
  const covered = summary?.covered || 0;
  const countOver = shouldCompact({ total: messages.length, covered });
  const budget = contextTokenStatus({
    messages: messages.slice(covered),
    summaryText: summary?.text || '',
    windowTokens,
  });
  if (!countOver && !budget.over) return summary;
  const keepRecent = resolveKeepRecent(messages);
  const cut = pickCompactCut(messages, { covered, keepRecent });
  if (cut < 0) return summary; // 找不到安全整轮边界/可丢太少 → 本轮不压
  const dropped = messages.slice(covered, cut);
  if (!dropped.length) return summary;
  try {
    const text = await summarizeSpan({ run, cred, model, previousSummary: summary?.text || '', dropped });
    const saved = setSummary(convId, { text, covered: cut, at: Date.now(), model });
    // 压缩事实落 journal（P0）：触发口径 / 前后估算 / 切点可回放，排查时能和 usage 曲线对上
    const after = contextTokenStatus({ messages: messages.slice(cut), summaryText: text, windowTokens });
    emitRunEvent(run, 'compaction', {
      reason: budget.over ? (countOver ? 'tokens+count' : 'tokens') : 'count',
      tokensBefore: budget.tokens,
      tokensAfter: after.tokens,
      window: budget.window,
      limit: budget.limit,
      visibleBefore: messages.length - covered,
      coveredBefore: covered,
      coveredAfter: cut,
      kept: messages.length - cut,
      summaryChars: text.length,
      model: pickModel(model, cred),
    });
    runActivity(run, compactNotice({ budget, cut, countOver }));
    return saved || summary;
  } catch (e) {
    runActivity(run, `⚠️ 历史摘要生成失败（本轮按原文继续）：${e?.message || String(e)}`);
    return summary;
  }
}

/** 压缩提示文案：区分触发口径（条数 / 接近窗口），token 口径带上估算占比 */
function compactNotice({ budget, cut, countOver }) {
  if (budget.over) {
    const pct = Math.round((budget.usageRatio || 0) * 100);
    const both = countOver ? '，条数亦超阈值' : '';
    return `📝 上下文接近上限（估算约 ${budget.tokens} tokens，占窗口 ${pct}%${both}）：已生成滚动摘要（覆盖前 ${cut} 条，原文保留）`;
  }
  return `📝 历史较长（>${COMPACT_TRIGGER} 条）：已生成滚动摘要（覆盖前 ${cut} 条，原文保留）`;
}

/**
 * 会话主体（fresh / resume 共用）：system + 历史 + 工具管线 + 每步检查点 + 事件流/索引。
 *
 * 检查点（T2-P3）：`conv-messages` 即检查点——agent-loop 每步的消息增量经 `onMessages` 立即落盘，
 * 进程崩溃后历史里留下的就是「干到一半」的现场；恢复时修复悬空调用即可继续（见 resumeOpenAiRun）。
 *
 * @param {object} p
 * @param {object} p.cred openai 凭证条目
 * @param {string} p.model
 * @param {string} [p.cwd] 工作目录（缺省退服务进程 cwd）
 * @param {string} [p.convId]
 * @param {Array} p.messages 历史消息（不含 system；末尾即接续点）
 * @param {string} [p.repoMapQuery] 仓库地图查询词（fresh=本次 prompt；resume=原 run 存档的 prompt）
 * @param {boolean} [p.continuation] 本次是不是续跑（续跑才续挂清单面板；新起一轮只认本轮的 TodoWrite）
 */
async function runOpenAiSession(run, { cred, model, effort, cwd, convId, messages, repoMapQuery, continuation = false }) {
  // UI 偏好（工具禁用名单 / 工具循环预算）读在系统提示词之前：Ultracode 的授权说明要看禁用名单，
  // 模型侧不该被告知「你有 Workflow」却又在调用时被拒（说清楚了它才会走普通路径）。
  const { disabledTools: rawDisabledTools, openaiMaxSteps } = getUiPrefs();
  const disabledToolsSet = new Set(Array.isArray(rawDisabledTools) ? rawDisabledTools : []);
  // 后台命令族开关（P1-6）：UI 只有一行（exec_command）——关掉它即整族禁用：
  // 会话控制工具（write_stdin/kill/list）失去意义，且不能让「关 Bash 却仍能起后台命令」留后门。
  if (disabledToolsSet.has('exec_command')) for (const n of EXEC_SESSION_TOOL_NAMES) disabledToolsSet.add(n);
  // Ultracode（自定义模型版）：用户在本会话显式开启 + 「工作流」工具没被禁用，才真的把工具交给模型。
  // 关闭时该工具根本不存在 → 模型不可能自发拉起并行子代理（额度可控，与 CLI 的显式授权语义一致）。
  const ultracode = !!run.ultracode && !disabledToolsSet.has('Workflow');
  if (run.ultracode && !ultracode) {
    runActivity(run, '⚠️ Ultracode 已开启，但「工作流」工具被禁用——本轮不做编排（可在「🔧 工具」里重新开启）');
  }
  // 工作目录：没选目录时退到服务进程 cwd（与 Claude 路径 SDK 默认一致）
  const workspace = cwd || process.cwd();
  // 任务清单（plan）读盘 + 系统提示注入（P1-9）：snapshot 是「跨压缩/跨重启的世界状态」，
  // **每轮都注入** `renderPlanSection`——压缩丢掉早期 TodoWrite 调用后模型也不失忆
  //（spec 2026-10-11-followup-persistence-and-plan-design）。读失败按「无计划」继续（尽力而为）。
  let persistedTodos = null;
  try {
    persistedTodos = convId ? getConvTodos(convId) : null;
  } catch (e) {
    logger.warn('web', '任务清单读取失败（按无计划继续）', { convId, err: e?.message || String(e) });
  }
  // 面板续挂只在续跑/恢复时做（continuation 由 resumeOpenAiRun 传 true）：新起一轮不该先把
  // 上一轮的旧清单挂在空气泡上——那看起来就是「上一轮的内容被复制到了这一轮」。口径与 Claude
  // 路径一致（run-claude.logic#isContinuationRun 的注释）。本轮模型一动清单，面板照常出现。
  if (continuation) hydrateRunTodos(run, persistedTodos?.todos);
  const planSection = renderPlanSection(persistedTodos?.todos);
  // 仓库地图（可按设置关闭）：确定性代码索引，给模型找线索的起点；构建失败 fail-open 返回空串
  const repoMapEnabled = getRepoMapSettings().enabled;
  let repoMap = '';
  if (repoMapEnabled) {
    repoMap = await getRepoMap({ cwd: workspace, query: repoMapQuery || '' });
  }
  // 上下文窗口：优先取本 run 所用模型在凭证元数据里的 context_window（/models 发现结果）。
  // 未知就传 null —— 前端只报 tokens、不算百分比；压缩的 token 触发同样只认已知分母（分母绝不猜）。
  const modelContextWindow = (() => {
    const id = pickModel(model, cred);
    const m = credentialModels(cred).find((x) => x.id === id);
    const win = Math.floor(Number(m?.contextWindow));
    return Number.isFinite(win) && win > 0 ? win : null;
  })();
  // 上下文压缩（T7；P0 双触发）：条数超限或估算 token 达窗口 90% → 滚动摘要（同凭证、fail-open）；
  // 模型视角 = 摘要 + 近期（原文保留在存储）。covered 越界（异常数据）时整体弃用摘要，退化为全量原文——fail-safe。
  const summary = await maybeCompactHistory({ run, cred, model, convId, messages, windowTokens: modelContextWindow });
  const summaryUsable = !!summary && Number.isFinite(summary.covered) && summary.covered <= messages.length;
  const viewMessages = summaryUsable && summary.covered > 0 ? messages.slice(summary.covered) : messages;
  // 发送前不变量终检（P0-③）：构建请求的最后一道 choke point——载入时已跑过一遍，此处幂等防御，
  // 交给模型的序列必须配对完整（切片沿 user 边界，正常零变化；脏数据/未来新增注入路径在此兜底）。
  const prepared = normalizeForModel(viewMessages);
  if (prepared.stats.synthesized || prepared.stats.droppedOrphans || prepared.stats.moved) {
    // 理论不可达：缺口在载入时已结清。真出现说明载入后引入了新缺口——留痕排障，视图修正不落盘。
    logger.warn('web', '发送前发现载入后引入的序列缺口（已按视图修正）', { runId: run.id, ...prepared.stats });
  }
  // system 提示词每轮注入、不进历史：落盘会在重放里逐轮堆积，且内容随 cwd 变化
  const modelMessages = [
    {
      role: 'system',
      content:
        composeSystemWithSummary(
          buildAgentSystemPrompt({ cwd: workspace, repoMap }) +
            // 后台命令族被禁用时不说（模型侧不该被告知不可用的工具，与 Ultracode 同纪律）
            (disabledToolsSet.has('exec_command') ? '' : buildExecSessionsPrompt()) +
            (ultracode ? buildUltracodeAuthPrompt() : ''),
          summaryUsable ? summary.text : '',
        ) + (planSection ? `\n\n${planSection}` : ''),
    },
    ...prepared.messages,
  ];

  // 内置文件/命令工具打底：harness 自己实现（对标 OpenCode），不依赖用户配 MCP 才有工具。
  // RepoMap 工具与地图注入同开关：enabled 时注入，按需按关键词重查 / refresh 强制重建。
  // Bash 执行后端（T6）：settings.exec.backend=container 时探测 docker/podman；
  // 引擎不可用 → unavailable（Bash fail-closed 明确报错，绝不静默退回本地）。
  const bashBackend = await resolveBashBackend(getExecSettings());
  if (bashBackend.kind !== 'local') runActivity(run, `Bash 执行后端：${describeBackend(bashBackend)}`);
  const builtin = createBuiltinTools({
    cwd: workspace,
    signal: run.abortController.signal,
    bashBackend,
    ...(repoMapEnabled
      ? {
          loadRepoMap: ({ query: q, refresh }) =>
            getRepoMap({ cwd: workspace, query: q, refresh, budgetChars: TOOL_BUDGET_CHARS }),
        }
      : {}),
  });

  // 命令会话（P1-6）：长任务/交互式命令的 start + poll（exec_command / write_stdin / list_processes /
  // kill_process，口径见 docs/superpowers/specs/2026-10-11-exec-sessions-design.md）。
  // 会话表 per-run：run 结束/停止在 finally 与 abort 信号两处 terminateAll，不留孤儿进程。
  const sessions = createExecSessions({ cwd: workspace, signal: run.abortController.signal, bashBackend });

  // 委托同事对话（AskColleague / WaitColleagueReply）：子引擎负责追问到结论，
  // 提问走审批卡、等待免审批；只有同事名册里、且配了 open_id 的人才问得到。
  const feishuAsk = createFeishuAskTools({
    runId: run.id,
    convId,
    signal: run.abortController.signal,
    pulse: () => runPulse(run),
    activity: (text) => runActivity(run, text),
  });

  // MCP 是可选增强（失败隔离；连不上只降级 MCP 部分，内置工具照常可用）。
  // 内置 MCP（registry 解析：context7 缺省开、figma 缺省关）+ 用户自定义 MCP，共用同一条连接管线；
  // 只读工具的免审批来自各自配置的 autoAllow（内置项自带注册表白名单）。
  let mcp = null;
  const mcpConfigs = [
    ...resolveBuiltinMcp({ state: getBuiltinMcp(), provider: 'openai' }),
    ...getMcpServers().filter((s) => s && s.command && s.enabled !== false),
  ];
  if (mcpConfigs.length) {
    try {
      mcp = await connectMcpServers(mcpConfigs, { cwd: cwd || undefined, signal: run.abortController.signal });
    } catch (e) {
      logger.warn('web', 'MCP 连接失败，降级为仅内置工具', { err: e?.message || String(e) });
      mcp = null;
    }
  }
  const mcpDefs = mcp?.toolDefs || {};
  // 联网工具（WebFetch/WebSearch）：WebSearch 依赖 settings.search 的 provider/key；
  // 审批由策略表网络类负责（default 档弹确认、bypass/无人值守放行）。
  const webTools = createWebTools({ search: getSearchSettings() });
  // 子代理句柄注册表（P1-7）：Task/Workflow 的每个子代理都登记成有地址、有状态、可续轮的实体，
  // 状态迁移落 journal（`agent_status`，回放 reducer 有 agents 车道）；句柄生命周期绑定本 run。
  const agentToolsEnabled = Object.fromEntries(AGENT_TOOL_NAMES.map((n) => [n, !disabledToolsSet.has(n)]));
  // 关掉「给子代理发消息」= 一并停用后台派发：没有取回结论的手段时，后台就是「烧完钱把结论丢掉」
  const backgroundAgents = agentToolsEnabled.send_message;
  const agents = createAgentRegistry({
    emit: (type, data) => emitRunEvent(run, type, data),
    activity: (line) => runActivity(run, line),
    pulse: () => runPulse(run),
    runTurn: (p) => callAgentTurn(p),
  });
  // 用户中止 run → 子代理一并收掉（它们的 abort 派生自 run，这里只是兜底清理未挂上的）
  run.abortController.signal.addEventListener('abort', () => agents.interruptAll(), { once: true });
  const localDefs = {
    ...builtin.toolDefs,
    ...sessions.toolDefs,
    ...feishuAsk.toolDefs,
    ...webTools.toolDefs,
    Task: SUBAGENT_TOOL_DEF,
    ...(ultracode ? { Workflow: WORKFLOW_TOOL_DEF } : {}),
    // 子代理控制面（send_message / wait_agent / interrupt_agent / list_agents）：逐个独立开关，
    // 关掉哪个就真的不装（模型不会去调一个不存在的工具，与 Workflow 同纪律）
    ...Object.fromEntries(Object.entries(agents.toolDefs).filter(([n]) => agentToolsEnabled[n])),
  };
  // 只读子代理（Task）的工具子集：从本地只读集合里挑（不含 Task/Workflow → 天然禁递归）
  const subagentDefs = pickReadonlyToolDefs({ ...builtin.toolDefs, ...webTools.toolDefs });
  const subagentExecute = async (name, input) =>
    Object.hasOwn(webTools.toolDefs, name) ? webTools.executeTool(name, input) : builtin.executeTool(name, input);
  /**
   * 跑子代理的**一轮**：嵌套 agent-loop，同凭证/模型/强度/预算；审批复用主 run 同一策略门
   * （网络类照常弹卡）；中间文本不上主气泡，活动转发带前缀。
   *
   * `messages` 由注册表给出（首轮 = 本次 prompt；续轮 = 该子代理自己的历史 + 新消息）——
   * Task（单发）、Workflow（并行编排）、send_message 续轮**共用这一处**，三个入口各写一份必然分叉。
   * system 每轮重建（工作目录随 run 变；历史里刻意不含 system）。
   */
  async function callAgentTurn({ agent, messages, signal }) {
    const label = agent?.label || '子代理';
    // 注册表给的是 agent 级 signal（interrupt_agent 只切它自己这一份）；provider 收 AbortController，这里桥接
    const ac = new AbortController();
    const linkAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) linkAbort();
      else signal.addEventListener('abort', linkAbort, { once: true });
    }
    const handle = providers.get('openai-compat').run(
      {
        messages: [{ role: 'system', content: buildSubagentSystemPrompt({ cwd: workspace }) }, ...messages],
        model: pickModel(model, cred),
        apiKey: cred.token,
        baseURL: cred.baseURL,
        abortController: ac,
        tools: subagentDefs,
        executeTool: subagentExecute,
        effort: effort || undefined,
        maxSteps,
      },
      {
        onActivity: (a) => runActivity(run, `🔍 ${label}：` + (a?.invalid ? `${a.name} 参数无效（已让其修正）` : summarizeTool(a))),
        canUseTool: (name, toolInput) => hooks.canUseTool(name, toolInput),
        onPulse: () => runPulse(run),
        // 子代理重试只上活动行、不写 journal（子代理不是 run 事实流的主体）；等待期间同样可被停止打断
        onRetry: (info) =>
          runActivity(run, `⏳ ${label}：模型流中断（${describeRetryKind(info.kind)}），${formatRetryDelay(info.delayMs)}后重试（第 ${info.retry}/${info.max} 次）`),
      },
    );
    try {
      const out = await handle.done;
      // 历史回给注册表：system 不进历史（每轮重建），收尾轮注入的 system 指令同样只是轮内私货
      const history = Array.isArray(out?.messages) ? out.messages.filter((m) => m?.role !== 'system') : messages;
      return {
        text: String(out?.result || '').trim(),
        history,
        inputTokens: out?.inputTokens,
        outputTokens: out?.outputTokens,
        aborted: !!out?.aborted,
      };
    } finally {
      signal?.removeEventListener?.('abort', linkAbort);
    }
  }

  /** 阻塞派发一个子代理并取回结论（Task / Workflow 用）：失败与中断都如实反映在文本里，不静默 */
  async function runAgentBlocking({ label, prompt, provider, goal }) {
    const body = String(prompt || '').trim();
    if (!body) return '（子代理未产出结论）';
    const out = await agents.spawnBlocking({ label, prompt: goal ? `总目标：${goal}\n\n你的子任务：${body}` : body, provider, role: 'explorer' });
    if (out.status === 'errored') return `❌ 子代理 ${out.agent?.id || ''} 失败：${out.agent?.error || '未知错误'}`;
    if (out.status === 'interrupted') return `❌ 子代理 ${out.agent?.id || ''} 被中断（本轮已停止）`;
    return out.text || '（子代理未产出结论）';
  }

  /** Task 工具执行体：单发只读子代理（`background:true` = 后台跑，结论用 wait_agent 取） */
  async function runSubagent(input) {
    const taskText = String(input?.prompt || input?.description || '').trim();
    if (!taskText) return '错误：prompt 不能为空';
    if (input?.background === true) {
      if (!backgroundAgents) {
        runActivity(run, '⚠️ 「给子代理发消息」被禁用 → 后台派发一并停用，本轮改为同步等结果');
      } else {
        return agents.spawnBackground({ label: '子代理', prompt: taskText, provider: 'openai-subagent', role: 'explorer' }).text;
      }
    }
    return runAgentBlocking({ label: '子代理', prompt: taskText, provider: 'openai-subagent' });
  }

  /**
   * Workflow 工具执行体（Ultracode 编排）：逐阶段并行跑只读子代理，把各子任务结论汇总回主模型。
   * 进度走活动转录（阶段/子任务各一行），abort 与工具审批复用主 run 那套；子任务同样进注册表
   * （provider=workflow-step），编排结束后 list_agents 仍看得到这一轮派了谁、各自状态如何。
   */
  async function runWorkflow(input) {
    const norm = normalizeWorkflowSpec(input);
    if (norm.error) return `错误：${norm.error}（Workflow 需要 name + phases[].tasks[].prompt）`;
    const plan = norm.plan;
    runActivity(run, `⚡ ${workflowLabel(plan)} 启动${plan.goal ? '：' + plan.goal : ''}`);
    const outcome = await runWorkflowPlan(plan, {
      signal: run.abortController.signal,
      runTask: (task, ctx) =>
        runAgentBlocking({
          label: `子任务 ${ctx.taskIndex + 1}「${task.title}」`,
          prompt: task.prompt,
          provider: 'workflow-step',
          goal: plan.goal,
        }),
      onProgress: (line) => runActivity(run, line),
    });
    return mergeWorkflowResults(plan, outcome);
  }
  const conflicts = Object.keys(mcpDefs).filter((n) => Object.hasOwn(localDefs, n));
  if (conflicts.length) runActivity(run, `⚠️ MCP 工具覆盖了同名本地工具：${conflicts.join('、')}`);
  const toolDefs = { ...localDefs, ...mcpDefs }; // 同名时用户显式配置的 MCP 优先
  const executeTool = async (name, input) => {
    if (Object.hasOwn(mcpDefs, name)) return mcp.executeTool(name, input);
    if (Object.hasOwn(sessions.toolDefs, name)) return sessions.executeTool(name, input);
    if (Object.hasOwn(feishuAsk.toolDefs, name)) return feishuAsk.executeTool(name, input);
    if (Object.hasOwn(webTools.toolDefs, name)) return webTools.executeTool(name, input);
    // 子代理控制面（P1-7）：被禁用时这里也拦一道（工具不装 = 模型不该调，硬调则 fail-closed）
    if (AGENT_TOOL_NAMES.includes(name)) {
      return agentToolsEnabled[name] ? agents.executeTool(name, input) : `错误：${name} 已在「🔧 工具」里被禁用`;
    }
    if (name === 'Task') return runSubagent(input);
    // fail-closed：没有授权位就不给跑（SDK 侧本就不会把未声明的工具交给模型，这里是第二道闸——
    // Workflow 直接决定额度开销，不能只靠「工具没注入，所以模型不会调」）
    if (name === 'Workflow') return ultracode ? runWorkflow(input) : '错误：本轮未开启 Ultracode，工作流不可用';
    return builtin.executeTool(name, input);
  };
  // 把连不上的 MCP server 明确告诉用户。此前只写 logger.warn，用户侧的表现是
  // 「模型突然没工具了、能力莫名退化」，几乎不可能自行定位到是某个 server 没起来。
  const mcpFailed = (mcp?.failed || []).concat(
    mcpConfigs.length && !mcp ? [{ label: '全部 MCP server', error: 'MCP 初始化失败' }] : [],
  );
  if (mcpFailed.length) {
    runActivity(
      run,
      `⚠️ ${mcpFailed.length} 个 MCP server 未连上，相关 MCP 工具本轮不可用（内置与委托工具不受影响）：` +
        mcpFailed.map((f) => `${f.label}（${f.error}）`).join('；'),
    );
  }

  // 检查点（P3）：每步消息增量立即落盘；游标记录已持久化条数，结束时兜底只补差量（防重复落盘）
  let persistedCount = modelMessages.length;
  const persistBatch = (batch) => {
    if (!convId || !Array.isArray(batch) || batch.length === 0) return;
    appendMessages(convId, batch);
    persistedCount += batch.length;
  };

  // 上下文窗口已在本函数开头算出（压缩的 token 触发与 onUsage 共用同一分母）
  const hooks = {
    onText: (t) => runText(run, t),
    // 每步用量 → 顶栏「上下文 xx%」：本步 inputTokens = 当前上下文大小，窗口 = 该模型的 context_window。
    // 子代理（Task）的一次性调用**不上报**：它的 prompt 是子任务，不代表主会话上下文。
    onUsage: (u) => runUsage(run, { ...u, model: pickModel(model, cred), contextWindow: modelContextWindow }),
    // TodoWrite → 任务清单面板（同 run-claude 口径：清单行不进活动转录）；
    // 其它工具 → 活动转录；invalid 调用要让人看见「参数无效、已让模型修正」
    onActivity: (a) => {
      if (a?.name === 'TodoWrite' && Array.isArray(a.input?.todos)) {
        runTodos(run, normalizeTodos(a.input.todos));
        return;
      }
      runActivity(run, a?.invalid ? `⚠️ ${a.name} 参数无效（已让模型修正）` : summarizeTool(a));
    },
    onResult: (info) => runResult(run, info),
    onPulse: () => runPulse(run),
    // 模型流重试（P0-④）：journal 记事实（回放/排障），活动行让用户看见「停下来喘口气」——表现为可停止的等待
    onRetry: (info) => {
      emitRunEvent(run, 'model_retry', {
        retry: info.retry,
        max: info.max,
        delayMs: info.delayMs,
        kind: info.kind,
        error: truncateForJournal(String(info.error || '')),
      });
      runActivity(
        run,
        `⏳ 模型流中断（${describeRetryKind(info.kind)}），${formatRetryDelay(info.delayMs)}后重试（第 ${info.retry}/${info.max} 次）`,
      );
    },
    onMessages: persistBatch, // 检查点钩子：agent-loop 每步 / 每条工具结果都会调
    // 步边界 steer（P1-10）：取走持有消息并进对话（runs.js 记 steer_consumed via='step' + consumed 广播，
    // 前端排队气泡随之清态）；本轮尚无可见产出时到达即抢占当前请求（Codex preempt 对位，见 agent-loop）。
    takeSteerMessages: () => consumeHeldMsgs(run, 'step'),
    shouldPreempt: () => run.heldMsgs.length > 0,
  };
  const autoAllow = buildAutoAllowSet(mcpConfigs); // 各 server 配置的免审批工具名并集
  // 工具策略门（T6）：档位 = 本 run 的 mode（routes-run 透传；缺省 default=非白名单全问，与改动前等价）。
  // 区内只读/写、越界、网络、危险命令的统一规则表在 capabilities/tool-policy.logic.js。
  // 工具循环预算：默认无上限（对齐 Claude Code / OpenCode）；基础设置可配正整数，
  // 到限时 agent-loop 会走 OpenCode 式强制收尾（工具禁用 + 总结），不再静默截断。
  const maxSteps = resolveMaxSteps(openaiMaxSteps);
  const policyGate = createPolicyGate({
    provider: 'openai-compat',
    // 实时读 run.mode（闭包）：中途切档立即对后续工具调用生效——openai 的 canUseTool 全程在线，
    // 不像 Claude SDK 受「起跑时是否装钩子」限制（2026-10-08 用户反馈：长任务里切「自动」无感）
    level: () => run.mode || 'default',
    workspace,
    disabledTools: disabledToolsSet,
    autoAllow,
    readOnlyExtra: FEISHU_ASK_READONLY_TOOLS,
    onDeny: (info) => emitRunEvent(run, 'policy_block', { tool: info.tool, klass: info.klass, ruleId: info.ruleId, reason: info.reason }),
  });
  // 每个工具调用过策略门：allow 直放；deny 明确拒绝；ask 走审批队列（复用 Claude 路径的允许/拒绝卡）。
  // 免审批来源统一在规则表内：MCP 白名单 / 内置只读且在工作目录内 / 委托的「等待」工具。
  hooks.canUseTool = async (toolName, input) => {
    const d = policyGate.decide(toolName, input);
    if (d.action === 'allow') return { behavior: 'allow' };
    if (d.action === 'deny') return { behavior: 'deny', message: d.reason };
    const choice = await askUser(run, {
      reqId: nextReqId(run),
      kind: 'permission',
      title: `自定义模型请求执行：${toolName}`,
      body: summarizeTool({ name: toolName, input }),
      options: [
        { id: 'allow', label: '允许' },
        { id: 'deny', label: '拒绝' },
      ],
      defaultChoice: 'deny',
    });
    return choice === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝了该操作' };
  };

  // 事件流 + 索引（P3 起 openai 参与跨重启检查点续跑）。
  // 索引写失败吞掉：最坏结果是崩溃后不自动续（退回今日行为）；journal 的 settled 事件负责下次启动兜底清理
  emitRunEvent(run, 'submitted', {
    provider: 'openai-compat',
    requestId: run.requestId || null,
    cwd: workspace,
    model: pickModel(model, cred),
    effort: effort || null,
    ultracode: run.ultracode || false,
    mode: run.mode || null, // 模式进 journal（对账/排障用；此前写死 null 无从查证）
    session: null,
    resumeAttempt: run.resumeAttempt || 0,
  });
  try {
    upsertRun({
      runId: run.id,
      convId,
      provider: 'openai-compat',
      session_id: null,
      cwd: workspace,
      model: pickModel(model, cred),
      effort: effort || null,
      mode: run.mode || null, // 续跑对账后按原档位恢复（此前写死 null，续跑必退回 default 逐次询问）
      ultracode: run.ultracode || false, // 续跑恢复编排授权（否则模型会引用一个已经不存在的工具）
      credId: cred.id,
      requestId: run.requestId || null,
      prompt: repoMapQuery ? truncateForJournal(repoMapQuery) : null,
      resumeAttempt: run.resumeAttempt || 0,
      pid: process.pid,
      startedAt: run.startedAt,
      updatedAt: Date.now(),
      status: 'running',
      lastSeq: run._journalSeq || 0,
    });
  } catch (e) {
    logger.warn('web', 'openai run 索引写入失败（已忽略；该 run 崩溃后不会自动续跑）', {
      runId: run.id,
      err: e?.message || String(e),
    });
  }

  // 图片附件内联（2026-10-15）：自定义模型路径此前只拿到「路径文本」——内置 Read 是纯文本工具
  // （二进制直接报错），图片对模型永远不可见。这里在**模型边界**把消息上显式 attachments 里的
  // 图片读成 file part（openai-compatible provider 映射为 image_url 的 data URL）。要点：
  //  - 只变换本次请求的视图：convo / 落盘 / 压缩仍持 {path,name} 元数据（prepareMessages 返回副本，
  //    剥掉 attachments 的也只有副本），每步都会重新按最新对话内联（含步边界插话）；
  //  - per-run cache：同一张图多步重放只读一次盘；
  //  - 活动转录按路径去重只报一次：模型每步都重建请求，不去重会刷屏；
  //  - fail-open：读取/超限只报告，绝不抛错——图片发不出去不能阻塞整个 run。
  const imageCache = new Map();
  const reportedImages = new Set();
  const prepareMessages = async (msgs) => {
    if (!Array.isArray(msgs) || !msgs.some((m) => m?.role === 'user' && Array.isArray(m.attachments) && m.attachments.length))
      return msgs;
    let result;
    try {
      result = await inlineImageAttachments(msgs, { readFile: fsp.readFile, statFile: fsp.stat, cache: imageCache });
    } catch (e) {
      logger.warn('web', '图片附件内联失败（按纯文本继续）', { runId: run.id, err: e?.message || String(e) });
      return msgs;
    }
    for (const it of result.inlined) {
      if (reportedImages.has('in:' + it.path)) continue;
      reportedImages.add('in:' + it.path);
      runActivity(run, `🖼 图片已随消息发给模型：${path.basename(it.path)}`);
    }
    for (const it of result.skipped) {
      if (reportedImages.has('out:' + it.path)) continue;
      reportedImages.add('out:' + it.path);
      runActivity(run, `⚠️ 图片未随消息发送：${path.basename(it.path)}（${it.reason}）`);
    }
    return result.messages;
  };

  const handle = providers.get('openai-compat').run(
    {
      messages: modelMessages,
      model: pickModel(model, cred),
      apiKey: cred.token,
      baseURL: cred.baseURL,
      abortController: run.abortController,
      tools: toolDefs,
      executeTool,
      effort: effort || undefined, // 自定义模型强度（reasoning_effort）；无档位模型不带
      maxSteps, // ∞ = 无上限（默认）；有限值到限走强制收尾
      prepareMessages,
    },
    hooks,
  );
  emitRunEvent(run, 'started', { pid: process.pid });
  handle.done
    .then(async (out) => {
      if (out && Array.isArray(out.messages)) {
        // 兜底：把没走 onMessages 的余量补上（正常为空）；system 提示词每轮重建，不进历史
        const rest = out.messages.slice(persistedCount);
        if (convId && rest.length) appendMessages(convId, rest);
      }
      // 排障留痕（2026-10-08 空输出事故）：步数/用量/空回复/预算耗尽都从日志可还原
      if (out?.exhausted && out?.wrappedUp) {
        runActivity(run, `⚠️ 已达工具步数上限（${Number.isFinite(maxSteps) ? maxSteps + ' 步' : '——'}），已让模型收尾总结`);
        logger.warn('web', 'openai run 达上限并强制收尾', { runId: run.id, steps: out.steps, maxSteps: Number.isFinite(maxSteps) ? maxSteps : null });
      } else if (out?.exhausted) {
        runActivity(run, `⚠️ 已达工具步数上限，且收尾调用失败——任务可能未完成，可回复「继续」`);
        logger.warn('web', 'openai run 工具步数耗尽（收尾失败）', { runId: run.id, steps: out.steps });
      } else if (out && !out.result) {
        logger.warn('web', 'openai run 未产出文本', { runId: run.id, steps: out?.steps ?? null });
      } else if (out) {
        logger.info('web', 'openai run 完成', {
          runId: run.id,
          steps: out.steps ?? null,
          inputTokens: out.inputTokens ?? null,
          outputTokens: out.outputTokens ?? null,
        });
      }
      // 后台子代理（P1-7）：主 run 已给出答复，但后台子代理可能还在跑。它的结论此时**已没有出口**
      //（主模型不会再被唤醒消费），所以要么等它收尾（结论进活动转录/句柄，供 list_agents 回看），
      // 要么如实中断——绝不静默丢弃、也不无限推迟 run 的收尾。
      try {
        const settled = await agents.settleAll({ timeoutMs: BACKGROUND_SETTLE_MS });
        if (settled.aborted) {
          logger.warn('web', 'openai run 收尾时仍有后台子代理未完成', { runId: run.id, aborted: settled.aborted, waited: settled.waited });
        }
      } catch (e) {
        logger.warn('web', '后台子代理收尾等待失败（已忽略）', { runId: run.id, err: e?.message || String(e) });
      }
      finishRun(run);
    })
    .catch((err) => {
      logger.warn('web', 'openai run 失败', { runId: run.id, err: err?.message || String(err) });
      failRun(run, `自定义模型执行失败：${err?.message || String(err)}`);
    })
    .finally(() => {
      try {
        removeRun(run.id); // 收尾即摘除索引（任何路径）；失败由 journal settled 在下次启动兜底
      } catch (e) {
        logger.warn('web', 'openai run 索引移除失败（已忽略）', { runId: run.id, err: e?.message || String(e) });
      }
      if (mcp) mcp.close();
      sessions.terminateAll(); // 命令会话（P1-6）：run 收尾一律杀掉后台进程（幂等；失败路径同款）
      agents.interruptAll(); // 子代理（P1-7）：同上，run 收尾不留还在跑的模型请求（幂等）
    });
}

/** openai-compat run 提交入口：历史 + 本次用户消息 = 检查点起点（模型调用前崩溃也能续） */
export async function startOpenAiRun(run, { prompt, model, credId, cwd, convId, requestId, mode, effort, ultracode, attachments } = {}) {
  run.convId = convId || run.convId || null;
  // 工具策略档位（T6）：与 Claude 路径共用同一份规则表；缺省 default（非白名单全问，与改动前等价）
  run.mode = mode || 'default';
  run.provider = 'openai-compat'; // journal/索引的 provider 归属（P3 起 openai 参与检查点续跑）
  run.requestId = requestId || null; // 提交幂等键（与 submissions 认领对账）
  run.effort = effort || null; // 自定义模型强度（reasoning_effort；无档位模型为 null，follow-up 快照取它）
  // Ultracode（会话级，见 capabilities/workflow.logic.js）：开着才把 Workflow 工具交给模型。
  // 快照到 run 上，follow-up 排空与检查点续跑才不丢这份授权（与 effort/mode 同款）。
  run.ultracode = !!ultracode;
  run.resumeAttempt = 0;
  // { id, token=apiKey, baseURL, model, ... } | null
  const { cred, reason } = resolveCredential(getTokens(), { credId, model });
  if (!cred) return failRun(run, '未配置可用的自定义模型凭证——请到设置页添加 OpenAI 兼容凭证（baseURL + apiKey）');
  // 指名了凭证却没命中 = 它已被删除。此时 baseURL/apiKey 来自别的号，
  // 极可能与 model 不配套；明确告知，而不是让用户对着一句 400 猜。
  if (credId && reason !== 'by-id') {
    runActivity(run, `⚠️ 指定的模型凭证已不存在，本轮改用「${cred.label || pickModel('', cred)}」（${cred.baseURL}）`);
  }
  // busy inbox 能力（T2-P4 → P1-10 steer → 2026-10-16 queue-first）：
  // 运行中新消息**默认排队**（followUp），当前 run 终结后由 conv-inbox 排空起下一轮；
  // 用户显式点「立即发送」才走 steer——step 模式步边界注入、本轮尚无可见产出时到达即抢占。
  run.capabilities.steer = true;
  run.capabilities.steerMode = 'step'; // /msg/now 依此走回执分支（Claude 缺省 turn 语义）
  run.capabilities.followUp = true;
  run.cwd = cwd || null;
  run.model = pickModel(model, cred); // buildFollowUpItem 取它做排空快照
  run.credId = cred.id;
  logger.info('web', 'openai-compat run 凭证解析', { credId: credId || null, picked: cred.id, reason, model: pickModel(model, cred), mode: run.mode, ultracode: run.ultracode });
  const history = loadNormalizedHistory(run, convId); // 发送前不变量：补悬空/剔孤立/剪空/截断（合成落盘）
  // 附件（图片）元数据结构化随本轮消息落盘：模型边界据此把图片内联成 vision 输入
  //（capabilities/image-attachments.logic.js），后续追问/检查点续跑重放同一份元数据。
  // 正文里的路径文本保持原样——Claude 路径与工具（Read/Grep）仍靠它定位文件。
  const attach = normalizeAttachments(attachments);
  const userMsg = { role: 'user', content: prompt, ...(attach.length ? { attachments: attach } : {}) };
  if (convId) appendMessages(convId, [userMsg]); // 有会话才持久化 user 消息（检查点的起点）
  await runOpenAiSession(run, {
    cred,
    model: pickModel(model, cred),
    effort: effort || null,
    cwd,
    convId,
    messages: [...history, userMsg],
    repoMapQuery: prompt,
  });
}

/**
 * 检查点续跑（P3）：**不追加「继续」提示词**——历史末尾是 tool 结果或用户消息时，
 * 模型看到的上下文天然是「干到一半的活」，直接继续即可。
 *
 * @param {object} run 新 run（调用方 createRun 并挂好 convId）
 * @param {object} entry run-index 里的旧条目（对账或手工恢复取得）
 */
export async function resumeOpenAiRun(run, entry) {
  run.convId = entry?.convId || run.convId || null;
  run.provider = 'openai-compat';
  run.requestId = entry?.requestId || null;
  run.resumeAttempt = entry?.resumeAttempt || 0;
  // 续跑按原档位恢复策略门（缺省 default）；缺失时逐次询问是 fail-closed 的兜底
  run.mode = entry?.mode || 'default';
  const { cred } = resolveCredential(getTokens(), { credId: entry?.credId, model: entry?.model });
  if (!cred) {
    return failRun(run, `续跑失败：原模型凭证已不可用（${entry?.model || '未知模型'}），请到设置页检查自定义模型配置`);
  }
  // busy inbox 能力（T2-P4 → P1-10 → queue-first）：续跑 run 同样可排队/可显式 steer，与起跑同款
  run.capabilities.steer = true;
  run.capabilities.steerMode = 'step';
  run.capabilities.followUp = true;
  run.cwd = entry?.cwd || null;
  run.model = entry?.model || pickModel('', cred);
  run.effort = entry?.effort || null; // 续跑原样恢复上轮强度（reasoning_effort）
  run.ultracode = !!entry?.ultracode; // 编排授权同样续上：历史里可能已经有 Workflow 的调用与结果
  run.credId = cred.id;
  const history = loadNormalizedHistory(run, run.convId);
  const last = history[history.length - 1];
  if (last && last.role === 'assistant') {
    // 检查点停在完整回复的末尾（进程死在「模型产出完成 → settle」之间的窗口）：没有要续的活。
    // 多为索引移除失败后的下次启动兜底；中性收尾，不烧一次模型调用去接一轮已完成的发言。
    logger.info('web', 'openai 检查点停在完整回复末尾，无需续跑', { convId: run.convId, fromRunId: entry?.runId || null });
    return finishRun(run);
  }
  if (!history.length) {
    return failRun(run, '续跑失败：会话检查点为空（无可续内容），请手动重发消息');
  }
  logger.info('web', 'openai-compat 从检查点续跑', { convId: run.convId, fromRunId: entry?.runId || null });
  await runOpenAiSession(run, {
    cred,
    model: entry?.model || pickModel('', cred),
    effort: entry?.effort || null,
    cwd: entry?.cwd,
    convId: run.convId,
    messages: history,
    repoMapQuery: entry?.prompt || '',
    continuation: true, // 续跑：清单面板续挂（新起一轮不挂，见 runOpenAiSession 注释）
  });
}

/** 启动对账后调度检查点续跑的延迟：本地检查点无需 Claude 的 token 重置缓冲，留一点让服务先就绪 */
const OPENAI_RESUME_DELAY_MS = 3000;

/** 执行一次续跑：新 run + resumed 事件 + resumeOpenAiRun（异常兜底 failRun） */
function doResumeOpenAi(entry, attempt) {
  const run = createRun();
  run.convId = entry.convId || null;
  emitRunEvent(run, 'resumed', { fromRunId: entry.runId || null, attempt, reason: 'orphan_recovery', pendingId: null });
  logger.info('web', '从检查点恢复中断的自定义模型任务', { fromRunId: entry.runId || null, convId: entry.convId || null, attempt });
  resumeOpenAiRun(run, { ...entry, resumeAttempt: attempt }).catch((e) =>
    failRun(run, `自定义模型续跑失败：${e?.message || String(e)}`),
  );
}

/**
 * 调度一次孤儿检查点续跑（P5 起由 run-claude.js#reconcileRuns 统一调用；本模块只提供起跑细节）。
 * 延迟让服务先就绪；deps 供测试注入 schedule/launch。
 */
export function scheduleOpenAiOrphanResume(
  entry,
  attempt,
  { schedule = (fn) => setTimeout(fn, OPENAI_RESUME_DELAY_MS), launch = doResumeOpenAi } = {},
) {
  schedule(() => launch(entry, attempt));
}
