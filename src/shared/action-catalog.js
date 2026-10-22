/**
 * 可用动作清单（纯函数）—— 给同事对话 agent 的「他能执行哪些操作」提供单一事实源。
 *
 * P4 起 run_action 是同事侧执行动作脚本的唯一入口（旧关键词意图路径已退役），
 * 但工具 schema 是稳定泛形（action + vars），模型必须**先知道有哪些动作、各要什么变量**
 * 才能可靠地调用。这份清单就是那份知识，按人按轮注入 system prompt。
 *
 * 判据与 `plugins/action-runner/agent-tools.js` 的 handler **同源**：
 *   enabled !== false   → 与设置页/欢迎卡一致（缺失视为启用）
 *   botId 相等          → 动作 per-bot 独享
 *   agentExposed !== false → 硬开关（默认开；关掉即清单与执行两侧一起消失）
 *   canRunAction(c, role)  → 权限闸（同事恒 'guest'；owner 档动作 agent 调不动）
 * 两处判据一旦分叉，就会出现「清单里有、调用被拒」或反过来「清单没有、实际能执行」的错位。
 *
 * persistent 变量的「上次使用」值从 user-vars 读、落 prompt 前**脱敏**（maskValue）——
 * 与老路径回显口径一致：让人能核对目标，但不把完整手机号喂进模型上下文。
 */
import { getConfigs as realGetConfigs } from '../store/action-configs.js';
import { getVar as realGetVar } from '../store/user-vars.js';
import { maskValue } from '../store/mask.js';
import { canRunAction } from './action-permission.js';
import { resolveVariable } from './action-vars.js';
import { logger } from './logger.js';

/** 单条动作描述进 prompt 的长度上限（超长描述属于配置卫生问题，不该挤掉别的动作） */
const DESC_MAX = 80;

/**
 * 列出某人在某 bot 下真正可执行的动作（已过滤 + 已脱敏）。
 *
 * @param {object} a
 * @param {string|null} a.botId 当前启用机器人 id
 * @param {string} [a.userId]  取 persistent 存量值的键（同事传 feishuOpenId —— 与老路径 user-vars 同键）
 * @param {string} [a.permissionRole] 权限角色，恒 'guest'（同事）；保留参数供测试与将来复用
 * @param {object} [deps] 注入便于单测
 * @returns {Array<{id:string, name:string, description:string, variables:Array}>}
 */
export function listAgentActions({ botId, userId = '', permissionRole = 'guest' } = {}, deps = {}) {
  const getConfigs = deps.getConfigs || realGetConfigs;
  const getVar = deps.getVar || realGetVar;
  const canRun = deps.canRun || canRunAction;

  return getConfigs()
    .filter((c) => c && c.enabled !== false && c.botId === botId && c.agentExposed !== false && canRun(c, permissionRole))
    .map((c) => ({
      id: String(c.id || ''),
      name: String(c.name || ''),
      description: String(c.description || '').slice(0, DESC_MAX),
      variables: (Array.isArray(c.variables) ? c.variables : [])
        .filter((v) => v && typeof v === 'object' && v.name)
        .map((v) => {
          const rv = resolveVariable(v);
          const stored = userId ? getVar(userId, rv.name) : null;
          return {
            name: rv.name,
            label: rv.label,
            required: !!v.required,
            example: rv.example,
            enum: rv.enum,
            // 存量值只给「有没有」与脱敏形态：完整手机号/凭证不进模型上下文
            last: stored === null || stored === undefined || stored === '' ? null : maskValue(String(stored), rv.name),
          };
        }),
    }));
}

/** 一条动作渲染成 prompt 里的一段（纯函数） */
function formatAction(a) {
  const head = `- ${a.id}　${a.name}${a.description ? '：' + a.description : ''}`;
  if (!a.variables.length) return head;
  const vars = a.variables.map(formatVariable).join(' ｜ ');
  return `${head}\n    变量：${vars}`;
}

function formatVariable(v) {
  const bits = [v.name, v.required ? '必填' : '可选'];
  if (Array.isArray(v.enum) && v.enum.length) bits.push('可选值：' + v.enum.join('/'));
  if (v.example) bits.push('示例：' + v.example);
  if (v.last !== null) bits.push('上次使用：' + v.last);
  return `${v.label}（${bits.join('，')}）`;
}

/**
 * 渲染成 system prompt 的「可用动作」块（不含标题，标题由 prompt.js 加）。
 * 空清单返回空串（调用方据此省略整个小节）。
 *
 * 超长截断：按配置顺序累加，超上限的部分整体省略并计数；**省略必须说出来**，
 * 否则模型会以为「清单里没有 = 这个动作不存在」，同事要求时答「没有这个功能」。
 */
export function renderActionCatalog(actions, { maxChars = 4000 } = {}) {
  if (!Array.isArray(actions) || !actions.length) return '';
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (let i = 0; i < actions.length; i++) {
    const block = formatAction(actions[i]);
    if (used + block.length + 1 > maxChars) {
      omitted = actions.length - i;
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }
  if (omitted > 0) {
    logger.warn('action-catalog', '动作清单超长已截断', { total: actions.length, omitted });
    lines.push(`- （另有 ${omitted} 项动作未列出，同事问到时可让对方直接说动作名）`);
  }
  return lines.join('\n');
}
