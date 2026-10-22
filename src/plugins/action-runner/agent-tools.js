/**
 * `run_action` —— 同事对话 agent 执行动作脚本的唯一入口（P4）。
 *
 * 取代旧的「关键词意图识别 + 槽位填充」路径（2026-10-09 起 action-runner 的意图 feature
 * 已从插件注册表摘除，见 index.js / feature/index.js 文件头）。三条设计要点：
 *
 * 1. **唯一 external 档工具**。动作脚本有真实外部副作用（如 `refund_orders.py` 真金白银），
 *    撤不回 —— 台账 `undo: null`，另附两道规矩：`agentExposed` 硬开关（关掉即清单与执行
 *    两侧一起消失）+ 执行前向同事复述确认（软约束，写死在 tool description 与 system prompt）。
 * 2. **权限闸原样保留**：`canRunAction(config, 'guest')`。同事在 permission.js 的语义里恒为
 *    guest，与 colleagues.js 的六个职位（后端/产品/…）是两套角色概念，不要混用。
 * 3. **schema 是稳定泛形**（action + vars），动作知识走 system prompt 的动态清单
 *    （shared/action-catalog.js）——不做法「动态 zod schema」：注册期 schema 是静态契约，
 *    塞运行时变化会让工具描述与现场配置漂移（spec §三 决策 5）。
 *
 * 变量合并与老路径同口径：声明外的键直接拒；persistent 变量缺省时从 user-vars 复用
 * （键=同事 feishuOpenId，与老路径同源）；必填缺失不执行、如实告诉模型还缺什么。
 */
import { z } from 'zod';
import { registerAgentTool } from '../../capabilities/agent-tools.js';
import { getConfig } from '../../store/action-configs.js';
import { getVar, setVar } from '../../store/user-vars.js';
import { canRunAction } from '../../shared/action-permission.js';
import { resolveVariable } from '../../shared/action-vars.js';
import { logger } from '../../shared/logger.js';
import { runAction, describeTarget } from './feature/script-runner.js';
import { pickMissingVars } from './feature/slot-filler.js';
import { normalizeValue } from './feature/local-extract.js';

/** 脚本输出进模型上下文的截断长度（与老路径 executeAction 的 tail 同口径） */
const OUTPUT_TAIL = 800;

export const RUN_ACTION = 'run_action';

/**
 * 一条缺失变量渲染成追问文案（纯函数）。与 shared/action-catalog.js 的 formatVariable 同口径、
 * 但更精简——这里只做「追问」这一件事，不报变量名/必填性/上次使用值。
 */
function formatMissingVar(m) {
  const hints = [];
  if (Array.isArray(m.enum) && m.enum.length) hints.push(`可选值：${m.enum.join('/')}`);
  if (m.example) hints.push(`示例：${m.example}`);
  return hints.length ? `${m.label}（${hints.join('，')}）` : m.label;
}

/**
 * 构造工具定义（导出供单测注入替身；模块加载时用默认真实依赖注册）。
 * @param {object} [deps] { getConfig, getVar, setVar, runAction, describeTarget, canRun }
 */
export function buildRunActionTool(deps = {}) {
  const getConfigFn = deps.getConfig || getConfig;
  const getVarFn = deps.getVar || getVar;
  const setVarFn = deps.setVar || setVar;
  const runFn = deps.runAction || runAction;
  const describeFn = deps.describeTarget || describeTarget;
  const canRun = deps.canRun || canRunAction;

  return {
    name: RUN_ACTION,
    description:
      '执行一项已配置的操作（跑脚本，例如清理数据、退款、重置账号）。' +
      '**执行前必须先把「动作名 + 参数 + 目标」复述给同事并得到确认**，然后才调本工具——' +
      '脚本一旦执行就撤不回。动作 id 与变量名必须来自系统提示的「可用动作」清单；' +
      '缺参数先向同事问清楚，不要猜着填。变量取值按同事原话传即可——别名会自动归一（如「开发」= dev），' +
      '执行失败时如实转述错误，不要润色成已办妥。',
    danger: 'external',
    exposedFlag: 'agentExposed',
    roles: ['*'], // 真正的闸在 handler 内 canRunAction —— 注册表这层不做角色过滤
    schema: {
      action: z.string().describe('动作 id（形如 ac_xxxx），从系统提示的「可用动作」清单里选'),
      vars: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('动作变量，键为变量名、值为字符串；没有变量时可省略'),
    },
    handler: async (input, ctx) => {
      const actionId = String(input?.action || '').trim();
      const raw = input?.vars;
      const provided = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

      const config = getConfigFn(actionId);
      if (!config || config.enabled === false) {
        return { error: `没有找到动作 ${actionId}，请从可用动作清单里选一个。` };
      }
      if (config.agentExposed === false) {
        return { error: `动作「${config.name}」没有开放给机器人调用。` };
      }
      if (!canRun(config, 'guest')) {
        return { error: `动作「${config.name}」需要更高权限，我这边执行不了。` };
      }

      const declared = Array.isArray(config.variables) ? config.variables : [];
      const unknown = Object.keys(provided).filter((k) => !declared.some((v) => v?.name === k));
      if (unknown.length) {
        return { error: `这些参数不属于该动作：${unknown.join('、')}。请按可用动作清单里的变量名传参。` };
      }

      // 1) 模型提供的值优先；2) persistent 变量缺省时复用存量值（与老路径一致，
      //    例如「不报号就复用上次的退款手机号」）；3) 空串视为没提供。
      const collected = {};
      for (const v of declared) {
        if (!v?.name) continue;
        const val = provided[v.name];
        if (val !== undefined && val !== null && String(val) !== '') collected[v.name] = String(val);
      }
      const userId = ctx?.openId || '';
      if (userId) {
        for (const v of declared) {
          if (!v?.name || !v.persistent || collected[v.name] !== undefined) continue;
          const stored = getVarFn(userId, v.name);
          if (stored !== null && stored !== undefined && String(stored) !== '') collected[v.name] = String(stored);
        }
      }

      const missing = pickMissingVars(config, collected);
      if (missing.length) {
        // P4 加固：追问信息带出「可选值/示例」，否则模型二次提问只会复读变量名，
        // 同事回一个短词时模型没有锚点把它归到具体取值，追问闭环容易断。
        const list = missing.map((v) => {
          const rv = resolveVariable(v);
          return { name: rv.name, label: rv.label || rv.name, enum: rv.enum, example: rv.example };
        });
        return {
          error: `还缺这些信息：${list.map(formatMissingVar).join('、')}。先向同事问清楚再执行。`,
          missing: list,
        };
      }

      // 声明契约校验：闭集（enum）与正则（pattern）越界一律不执行。
      // P4 加固：enum 不再做精确匹配——模型转述同事的话常是别名（「开发环境」「开发」而非「dev」），
      // 精确比对会把别名当非法值退回、白多问一轮。这里复用老路径的 normalizeValue
      //（含 junk 剥离、小写、strong/weak 别名、以及「别名目标必须落在 enum 内」最后一道闸），
      // 别名归一成规范值后再喂脚本，脚本拿到的永远是 enum 里的值。
      for (const v of declared) {
        const val = collected[v.name];
        if (!v?.name || val === undefined) continue;
        const rv = resolveVariable(v);
        if (rv.kind === 'enum') {
          const normalized = normalizeValue(rv, val, { weak: true });
          if (!normalized) {
            return {
              error: `「${rv.label}」的值「${String(val).slice(0, 20)}」不是合法值，只能是：${rv.enum.join(' / ')}，请和同事核对后再试。`,
            };
          }
          collected[v.name] = normalized;
        } else if (rv.pattern) {
          try {
            if (!new RegExp(`^(?:${rv.pattern})$`).test(val)) {
              return { error: `「${rv.label}」的格式不对，请和同事核对后再试。` };
            }
          } catch {
            /* pattern 存坏时跳过（保存时已校验；坏数据不阻断执行） */
          }
        }
      }

      const r = await runFn(config, userId, collected);

      // 持久变量落盘：与老路径同键（openId）同语义。失败不阻断（下次再填一遍而已）
      if (userId) {
        for (const v of declared) {
          if (v?.persistent && collected[v.name]) {
            try {
              setVarFn(userId, v.name, collected[v.name]);
            } catch (e) {
              logger.warn('action-agent', '持久变量落盘失败（不阻断）', { var: v.name, err: e?.message || String(e) });
            }
          }
        }
      }

      const target = describeFn(config, collected);
      const output = String(r?.output || '').slice(-OUTPUT_TAIL);
      if (!r?.ok) return { ok: false, output: output || '脚本无输出', target };
      return { ok: true, output: output || '脚本无输出（退出码 0）', target };
    },
  };
}

// 模块加载即注册（与卡片回调同一范式：插件停用 → 本文件不被 import → 工具自然缺席）
registerAgentTool(buildRunActionTool());
