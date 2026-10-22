/**
 * 内置模型任务 → 实际执行目标 的解析层。
 *
 * 目标两种形态（与 settings.modelTasks 的存储形状一致，见 model-task-catalog.normalizeTaskTarget）：
 *   { provider:'claude-agent', model }              —— 走 runClaude（Claude 订阅）
 *   { provider:'openai-compat', credId, model }     —— 走自定义模型通道（API Key 凭证）
 *
 * settings.modelTasks 只存「用户显式覆盖」；无覆盖时按 FALLBACKS 回落到改造前的现状默认
 * （分类类 Haiku / 对话类跟随 Claude Code 默认），保证升级后行为逐字不变。
 *
 * 调用方约定：
 *   - 只关心 Claude 通道的旧代码可继续用 resolveTaskModel(id)（openai 目标返回 undefined——
 *     这些点必须改用 resolveTaskTarget 走双通道，见各调用点注释）；
 *   - 新接线的调用点一律先 resolveTaskTarget，再按 provider 分派。
 */
import { config } from './config.js';
import { DEFAULT_PROVIDER_ID } from './provider-ids.js';
import { MODEL_TASK_BY_ID, MODEL_TASK_DEFS, normalizeTaskTarget } from './model-task-catalog.js';
import { getMemoryBankSettings, getModelTasks } from '../store/settings.js';

/**
 * 各任务的现状默认（fallback）：返回模型 id 字符串；null/'' = 跟随 Claude Code 默认模型
 * （即 ~/.claude/settings.json 的 model，本机为 opus[1m]）。
 */
const FALLBACKS = {
  intent: () => config.intent.classifyModel,
  taskTriage: () => config.taskTriage.classifyModel,
  feishuAsk: () => config.feishuAsk.model,
  patrolMap: () => config.intent.classifyModel,
  tracking: () => config.intent.classifyModel,
  actionLearn: () => config.intent.classifyModel,
  // 记忆库：优先用 memoryBank.model（老配置入口），否则退到分类轻模型
  memoryBank: () => getMemoryBankSettings().model || config.intent.classifyModel,
  // Auto 判档分类器（tier.js 里写的 Haiku）
  autoTier: () => 'claude-haiku-4-5',
};

/** 任务「无用户覆盖」时的默认目标（供 UI 展示 + 运行时回落） */
export function fallbackTaskTarget(id) {
  const fb = typeof FALLBACKS[id] === 'function' ? FALLBACKS[id]() : null;
  const model = typeof fb === 'string' && fb.trim() ? fb.trim() : null;
  return { provider: DEFAULT_PROVIDER_ID, model };
}

/**
 * 解析任务的实际执行目标。
 * @returns {{provider:string, model:string|null, credId?:string}}
 */
export function resolveTaskTarget(id) {
  const stored = normalizeTaskTarget(getModelTasks()?.[id]);
  return stored || fallbackTaskTarget(id);
}

/**
 * 便捷取模型名（Claude 通道）——优先级：用户显式覆盖 > 调用点传入的 model > 任务现状默认。
 * openai-compat 目标刻意返回 null（需要双通道的调用点请直接用 resolveTaskTarget + 分派）。
 */
export function resolveTaskModel(id, explicitModel = null) {
  const stored = normalizeTaskTarget(getModelTasks()?.[id]);
  if (stored) return stored.provider === DEFAULT_PROVIDER_ID ? stored.model : null;
  if (typeof explicitModel === 'string' && explicitModel.trim()) return explicitModel.trim();
  return fallbackTaskTarget(id).model;
}

/** 给设置页的视图：每项的当前覆盖值 + 默认值 */
export function buildModelTaskView() {
  const stored = getModelTasks() || {};
  return MODEL_TASK_DEFS.map((d) => ({
    id: d.id,
    group: d.group,
    label: d.label,
    hint: d.hint,
    value: normalizeTaskTarget(stored[d.id]), // null = 未覆盖
    fallback: fallbackTaskTarget(d.id),
  }));
}

/** 任务定义查询（设置路由校验用） */
export function isKnownTaskId(id) {
  return !!MODEL_TASK_BY_ID[id];
}
