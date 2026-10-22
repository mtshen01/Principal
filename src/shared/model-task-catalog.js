/**
 * 内置模型任务目录 —— 「设置 → 模型 → 功能模型」里每一项的 id / 分组 / 文案。
 *
 * 纯数据 + 纯函数、只 import provider-ids：store/settings.js 的 normalize 要按 id
 * 白名单收殓用户配置，而 settings.js 被 config.js 依赖，这里不能反向拖进任何有依赖的
 * 模块（循环导入）。默认值的解析在 shared/model-tasks.js（那里可以 import config / settings）。
 *
 * 新增一个任务 = 这里加一行 + model-tasks.js 加 fallback + 调用点接入 resolveTaskTarget。
 */
import { DEFAULT_PROVIDER_ID } from './provider-ids.js';

export const MODEL_TASK_DEFS = Object.freeze([
  // —— 飞书机器人 ——
  { id: 'feishuExec', group: '飞书机器人', label: '主人对话（执行台）', hint: '你在飞书私聊机器人时，执行任务用的模型' },
  { id: 'intent', group: '飞书机器人', label: '意图识别', hint: '把飞书消息分类为 bug / 需求 / 提问 / 材料 / 其他' },
  { id: 'taskTriage', group: '飞书机器人', label: '待处理项分类', hint: '「待处理」流程里的动作/类型分类' },
  { id: 'feishuAsk', group: '飞书机器人', label: '委托同事判定', hint: '「问同事」的追问话术与结论摘要生成' },
  { id: 'review', group: '飞书机器人', label: 'AI 评审', hint: '需求/故障评审门 + BUG 前后端归属判定' },
  { id: 'colleague', group: '飞书机器人', label: '同事对话', hint: '群里同事私聊机器人时的应答与工具调用' },

  // —— 需求 ——
  { id: 'reqDoc', group: '需求', label: '需求文档生成', hint: '评审期生成开发文档 / 不确定点问卷' },
  { id: 'reqMap', group: '需求', label: '需求地图 / 影响预估', hint: '需求地图生成、修复、变迁重生成与变动影响预估' },

  // —— 托管 ——
  { id: 'taskOps', group: '托管', label: '需求/故障分析', hint: '接单后的只读分析（不改码）' },
  { id: 'taskOpsDev', group: '托管', label: '需求/故障开发', hint: '接单后的代码实现与修复' },
  { id: 'projectQa', group: '托管', label: '项目问答', hint: '完全托管下对项目代码的只读问答' },
  { id: 'autoDev', group: '托管', label: '自动合并/回滚', hint: '合并冲突处置与回滚方案的 LLM 兜底' },

  // —— 巡检 ——
  { id: 'patrolMap', group: '巡检', label: '巡检字段映射', hint: '多维表格结构自适应字段映射（需求巡检 / BUG 巡检）' },
  { id: 'tracking', group: '巡检', label: '数据理解', hint: 'Tracking Stats 的埋点/数据语义理解' },
  { id: 'actionLearn', group: '巡检', label: '动作学习', hint: '关键词学习与字段槽位抽取' },

  // —— 项目 ——
  { id: 'checkup', group: '项目', label: '项目体检', hint: '各维度评委 + 整体审查' },
  { id: 'optimize', group: '项目', label: '项目优化', hint: '规则修复（LLM 编辑）/ 技能描述 / 优化用代码地图' },

  // —— 记忆库 ——
  { id: 'memoryBank', group: '记忆库', label: '记忆库提炼', hint: '从会话转录中提炼用户偏好' },

  // —— 基础 ——
  { id: 'autoTier', group: '基础', label: 'Auto 判档', hint: 'Auto 模式下判定任务档位的分类器' },
]);

/** 合法任务 id 列表（settings normalize 白名单用） */
export const MODEL_TASK_IDS = Object.freeze(MODEL_TASK_DEFS.map((d) => d.id));

/** id → 定义（解析用） */
export const MODEL_TASK_BY_ID = Object.freeze(
  Object.fromEntries(MODEL_TASK_DEFS.map((d) => [d.id, d])),
);

/**
 * 校验并归一一条任务目标（纯函数）。
 *
 * 形态（存进 settings.modelTasks 的形状与解析出的形状一致）：
 *   { provider:'claude-agent', model:'claude-haiku-4-5' }
 *   { provider:'openai-compat', credId:'tk_xxx', model:'deepseek-chat' }
 *
 * @returns {object|null} 合法目标；非法/缺字段 → null（调用方应剔除该键）
 */
export function normalizeTaskTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const provider =
    raw.provider === 'openai-compat'
      ? 'openai-compat'
      : raw.provider === DEFAULT_PROVIDER_ID
        ? DEFAULT_PROVIDER_ID
        : null;
  if (!provider) return null;
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) return null;
  if (provider === 'openai-compat') {
    const credId = typeof raw.credId === 'string' ? raw.credId.trim() : '';
    if (!credId) return null;
    return { provider, credId, model };
  }
  return { provider, model };
}
