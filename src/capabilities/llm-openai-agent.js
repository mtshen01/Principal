/**
 * 自定义模型（openai-compat）的内部任务执行通道 —— 单轮判定 + 带工具 agent 两种形态。
 *
 * 背景：「设置 → 模型 → 功能模型」允许把任意内置任务指向 API Key 凭证里的模型
 * （DeepSeek/Qwen/…）。此前这些任务全部写死走 runClaude（Claude 订阅通道），
 * 本模块是 llm-classify / llm-readonly-agent / llm-write-agent / agent-session 的
 * openai 分支共用底座：
 *   - 单轮零工具 → runOpenAiOnce（对应 llm-classify）
 *   - 带工具多轮 → runOpenAiAgentTurn（对应 readonly/write/business 三种工具面）
 *
 * 工具面复用 providers/builtin-tools 的宿主工具（Read/Write/Edit/Glob/Grep/Bash）与
 * capabilities/agent-tools 的进程内业务工具（同事 agent），不做第二套实现。
 *
 * 教训（为什么动态 import）：openai-compat-model / builtin-tools 会拖进 `ai` + zod 约 8.5MB
 * heap，且本模块会被 feishu 进程的模块图拉进启动链 —— 只用 Claude 的用户不该付这份成本。
 *
 * ⚠️ 与 Claude 通道的能力差异（如实记录，不粉饰）：
 *   - 没有 SDK 的 PreToolUse 三层只读闸；只读保证由 canUseTool 白名单 + 路径围栏提供
 *     （builtin 工具不读 Claude settings.json 的 allow 规则，所以不存在「被 allow 架空」问题）；
 *   - 没有 Skills / Task 子代理 / WebSearch 等 Claude Code 专有工具；
 *   - 会话续接没有 SDK session，多轮靠调用方传入历史消息（见 history 参数）。
 */
import path from 'node:path';
import { logger } from '../shared/logger.js';
import { DEFAULT_PROVIDER_ID } from '../shared/provider-ids.js';
import { isInsideWorkspace, resolveToolPath } from '../shared/workspace-paths.js';
import { getTokenById } from './token-rotation.js';

/** 单轮判定默认超时（对齐 llm-classify 的量级） */
export const OPENAI_ONCE_TIMEOUT_MS = 120_000;
/** 带工具 agent 默认超时（对齐 llm-readonly-agent 的 600s） */
export const OPENAI_AGENT_TIMEOUT_MS = 600_000;

const READONLY_TOOL_NAMES = ['Read', 'Grep', 'Glob'];
const WRITE_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const FULL_TOOL_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

/**
 * 按凭证 id 取 openai-compat 接入信息。
 * @returns {{apiKey:string, baseURL:string}|null} 不存在/非该 provider/字段不全 → null
 */
export function resolveApiCred(credId) {
  const t = getTokenById(credId);
  if (!t) return null;
  if ((t.providerId || DEFAULT_PROVIDER_ID) !== 'openai-compat') return null;
  const apiKey = typeof t.token === 'string' ? t.token.trim() : '';
  const baseURL = typeof t.baseURL === 'string' ? t.baseURL.trim() : '';
  if (!apiKey || !baseURL) return null;
  return { apiKey, baseURL };
}

/** handler 返回形状包装：字符串原样透传，其余 JSON 序列化（undefined → 'null'，见 agent-tools.js 的教训） */
function toolText(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return text === undefined ? 'null' : text;
}

/** 剥掉 `__private`（只给台账、不给模型看的字段，同 agent-tools.js 的约定） */
function stripPrivate(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!('__private' in result)) return result;
  const copy = { ...result };
  delete copy.__private;
  return copy;
}

/** 组装进程内业务工具（同事 agent）为 AI SDK 工具集合 + 执行器 */
async function buildBusinessTools(role, ctx) {
  const [{ listAgentTools, filterToolsByRole }, { z }] = await Promise.all([
    import('./agent-tools.js'),
    import('zod'),
  ]);
  const defs = filterToolsByRole(listAgentTools(), role);
  const map = new Map(defs.map((d) => [d.name, d]));
  const frozenCtx = ctx && typeof ctx === 'object' ? Object.freeze({ ...ctx }) : ctx;
  const tools = {};
  for (const d of defs) {
    tools[d.name] = { description: d.description, inputSchema: z.object(d.schema) };
  }
  const execute = async (name, input) => {
    const d = map.get(name);
    if (!d) throw new Error(`未知工具：${name}`);
    const result = await d.handler(input, frozenCtx);
    return toolText(stripPrivate(result));
  };
  return { tools, execute };
}

/**
 * 单轮零工具调用（llm-classify 的 openai 分支）。
 *
 * 失败语义对齐 llm-classify：**永远不 throw**，返回可能为空的 text + reason，
 * 由调用方按「解析不出 → null」的现有兜底处理。
 *
 * @returns {{ text: string, reason: null|'no-credential'|'timeout'|'cancelled'|'error' }}
 */
export async function runOpenAiOnce({
  credId, model, prompt, systemPrompt,
  timeoutMs, signal, logTag = 'openai-once', effort,
} = {}) {
  const cred = resolveApiCred(credId);
  if (!cred || !model) {
    logger.warn('llm-openai', '凭证缺失或模型为空，跳过调用', { logTag, credId, model });
    return { text: '', reason: 'no-credential' };
  }
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : OPENAI_ONCE_TIMEOUT_MS;
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, budget);
  const relay = () => abort.abort();
  signal?.addEventListener('abort', relay, { once: true });

  let text = '';
  let reason = null;
  try {
    const { createOpenAiCompatModelRun } = await import('../providers/openai-compat-model.js');
    const modelRun = createOpenAiCompatModelRun({
      ...cred, model, abortSignal: abort.signal,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: prompt },
    ];
    const { stream, finished } = modelRun(messages, { disableTools: true });
    for await (const ev of stream) {
      if (ev.type === 'text' && ev.text) text += ev.text;
    }
    await finished;
  } catch (e) {
    reason = timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'error';
    logger.warn('llm-openai', '单轮调用异常（已落兜底）', { logTag, reason, err: e?.message || String(e) });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
  return { text, reason };
}

/**
 * 带工具多轮 agent 调用（readonly/write/full/business 四种工具面）。
 *
 * @param {object} opts
 * @param {'readonly'|'write'|'full'|'business'} [opts.mode='readonly']
 * @param {string[]} [opts.allowPaths]  write 模式可写文件清单（相对 cwd 或绝对路径）
 * @param {string[]} [opts.readRoots]   readonly 模式额外可读目录（如侧车评审的后端目录）
 * @param {string}   [opts.role]        business 模式的同事角色 id
 * @param {object}   [opts.ctx]         business 模式 handler 的第二参
 * @param {string[]} [opts.denyTools]   显式停用的工具名（对齐 UI 偏好里的 disabledTools）
 * @param {Array}    [opts.history]     business/full 模式续跑用的历史消息（runAgentLoop 输出可直接回传）
 * @returns {{ result:string, messages:Array, toolTrace:Array, wrote:string[], denied:string[], reason:null|'no-credential'|'timeout'|'cancelled'|'error' }}
 */
export async function runOpenAiAgentTurn({
  credId, model, prompt, systemPrompt, cwd,
  mode = 'readonly', allowPaths = [], readRoots = [], role = '', ctx, denyTools = [],
  maxSteps, timeoutMs, signal, logTag = 'openai-agent', onText, history = null,
} = {}) {
  const empty = { result: '', messages: [], toolTrace: [], wrote: [], denied: [] };
  const cred = resolveApiCred(credId);
  if (!cred || !model) {
    logger.warn('llm-openai', '凭证缺失或模型为空，跳过调用', { logTag, credId, model });
    return { ...empty, reason: 'no-credential' };
  }

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : OPENAI_AGENT_TIMEOUT_MS;
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, budget);
  const relay = () => abort.abort();
  signal?.addEventListener('abort', relay, { once: true });

  const workspace = cwd || process.cwd();
  const wrote = [];
  const denied = [];
  const toolTrace = [];
  try {
    const [{ createBuiltinTools }, { createOpenAiCompatModelRun }, { runAgentLoop }] = await Promise.all([
      import('../providers/builtin-tools.js'),
      import('../providers/openai-compat-model.js'),
      import('../providers/agent-loop.js'),
    ]);

    const pool = createBuiltinTools({ cwd: workspace, signal: abort.signal });
    const builtinNames =
      mode === 'business' ? []
        : mode === 'readonly' ? READONLY_TOOL_NAMES
          : mode === 'write' ? WRITE_TOOL_NAMES
            : FULL_TOOL_NAMES;
    const tools = {};
    for (const n of builtinNames) if (pool.toolDefs[n]) tools[n] = pool.toolDefs[n];

    let executeTool = (name, input) => pool.executeTool(name, input);
    let allowedNames = new Set(builtinNames);
    if (mode === 'business') {
      const biz = await buildBusinessTools(role, ctx);
      Object.assign(tools, biz.tools);
      const bizNames = new Set(Object.keys(biz.tools));
      executeTool = (name, input) => (bizNames.has(name) ? biz.execute(name, input) : pool.executeTool(name, input));
      allowedNames = bizNames;
    }

    const roots = [path.resolve(workspace), ...readRoots.map((r) => path.resolve(r))];
    const allowSet = new Set(allowPaths.map((p) => path.resolve(workspace, String(p))));
    const denySet = new Set(Array.isArray(denyTools) ? denyTools : []);
    const isInsideRoots = (p) => {
      const abs = resolveToolPath(p, workspace);
      return roots.some((root) => isInsideWorkspace(root, abs));
    };

    const canUseTool = async (name, input) => {
      if (denySet.has(name)) {
        denied.push(name);
        return { behavior: 'deny', message: '该工具已被停用（可在「设置 → 权限」里查看）。' };
      }
      if (!allowedNames.has(name)) {
        denied.push(name);
        return { behavior: 'deny', message: '该工具不在本次任务的可用范围内。' };
      }
      if (mode === 'readonly') {
        const target = input?.file_path ?? input?.path;
        if (typeof target === 'string' && target && !isInsideRoots(target)) {
          denied.push(`${name}:${target}`);
          return { behavior: 'deny', message: '本次调用只允许读取指定目录内的文件。' };
        }
        return { behavior: 'allow' };
      }
      if (mode === 'write' && (name === 'Write' || name === 'Edit')) {
        const target = input?.file_path;
        const abs = typeof target === 'string' && target ? path.resolve(workspace, target) : '';
        if (!abs || !allowSet.has(abs)) {
          denied.push(`${name}:${target || '(未给路径)'}`);
          return {
            behavior: 'deny',
            message: `只允许修改这些文件：${allowPaths.join('、') || '(无)'}。请不要创建或修改其它文件。`,
          };
        }
        wrote.push(abs);
        return { behavior: 'allow' };
      }
      return { behavior: 'allow' };
    };

    const modelRun = createOpenAiCompatModelRun({ ...cred, model, tools, abortSignal: abort.signal });
    const messages = Array.isArray(history) && history.length ? history.slice() : [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const out = await runAgentLoop(
      { messages, modelRun, executeTool, maxSteps, signal: abort.signal },
      {
        onText,
        onActivity: ({ name, input }) => toolTrace.push({ name, input }),
        canUseTool,
      },
    );
    return {
      result: out.result || '',
      messages: out.messages || [],
      toolTrace,
      wrote: wrote.map((abs) => path.relative(workspace, abs).replace(/\\/g, '/')),
      denied,
      reason: signal?.aborted ? 'cancelled' : null,
    };
  } catch (e) {
    logger.warn('llm-openai', 'agent 调用异常（已落兜底）', { logTag, err: e?.message || String(e) });
    return {
      result: '',
      messages: [],
      toolTrace,
      wrote,
      denied,
      reason: timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'error',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}
