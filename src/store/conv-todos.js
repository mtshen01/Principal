/**
 * 任务清单（plan）落盘（P1-9，spec `docs/superpowers/specs/2026-10-11-followup-persistence-and-plan-design.md`）。
 *
 * 语义：`TodoWrite` 的任务清单快照按 **conv** 存最近一次（`conv-todos.json`），让「模型自己的
 * 计划」跨 run / 跨进程 / 跨压缩存活——run 开始时恢复 `run.todos`（面板续挂）并把清单渲染成
 * 系统提示小节重新注入（压缩丢了早期 TodoWrite 调用也不失忆）。
 *
 * 形状：`{ v:1, convs: { [convId]: { todos, at, runId } } }`。写方是 `runs.js#runTodos` 的 sink
 * （接线 `entrypoints/web/run-durability.js`），读方是各起跑入口（run-openai / run-claude）。
 *
 * 纪律：损坏拒写、抛错（store 惯例），吞错在上层；空清单 = 删键（用户/模型清空计划即无计划）。
 * 上限：单清单 50 项（与 providers/normalizeTodos 一致）；文件 300 conv，超量按 at 淘汰最旧。
 */
import { readJson, updateJson, writeJson } from './index.js';

const FILE = 'conv-todos.json';
/** conv 数上限（超量按 at 淘汰最旧）；导出供测试 */
export const MAX_CONVS = 300;
const MAX_ITEMS = 50;
const STATUS = new Set(['pending', 'in_progress', 'completed']);
const empty = () => ({ v: 1, convs: {} });

/**
 * 清单归一（纯函数）：只留 `{content, status, activeForm?}`，status 白名单，最多 50 项。
 * 形状与 `providers/builtin-tools.js#normalizeTodos` 对齐；store 不反向依赖 providers，故本地实现。
 */
export function sanitizeTodos(list) {
  return (Array.isArray(list) ? list : [])
    .map((t) => {
      const content = typeof t?.content === 'string' ? t.content.trim() : '';
      if (!content) return null;
      const status = STATUS.has(t?.status) ? t.status : 'pending';
      const activeForm = typeof t?.activeForm === 'string' && t.activeForm.trim() ? t.activeForm.trim() : '';
      return { content, status, ...(activeForm ? { activeForm } : {}) };
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

/** 读取某 conv 的最近清单；无/空 → null */
export function getConvTodos(convId) {
  if (!convId) return null;
  const state = readJson(FILE, empty());
  const entry = state && typeof state === 'object' && state.convs ? state.convs[convId] : null;
  const todos = sanitizeTodos(entry?.todos);
  if (!todos.length) return null;
  return { todos, at: Number.isFinite(entry?.at) ? entry.at : null, runId: entry?.runId ?? null };
}

/**
 * 覆盖写入某 conv 的清单快照；空清单删键。返回是否受理（convId 缺失 → false）。
 * @param {string} convId
 * @param {Array} todos
 * @param {{runId?:string|null, now?:number}} [opts]
 */
export function setConvTodos(convId, todos, { runId = null, now = Date.now() } = {}) {
  if (!convId) return false;
  const norm = sanitizeTodos(todos);
  updateJson(FILE, empty(), (cur) => {
    const convs = { ...(cur && cur.convs && typeof cur.convs === 'object' ? cur.convs : {}) };
    if (!norm.length) {
      if (!convs[convId]) return undefined; // 已是「无计划」态，不写盘
      delete convs[convId];
    } else {
      convs[convId] = { todos: norm, at: now, runId: runId || null };
      const ids = Object.keys(convs);
      if (ids.length > MAX_CONVS) {
        ids.sort((a, b) => (Number(convs[a]?.at) || 0) - (Number(convs[b]?.at) || 0));
        for (const k of ids.slice(0, ids.length - MAX_CONVS)) {
          if (k !== convId) delete convs[k];
        }
      }
    }
    return { v: 1, convs };
  });
  return true;
}

/** 清空（测试/运维用） */
export function clearAllConvTodos() {
  writeJson(FILE, empty());
}

const MARK = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

/**
 * 渲染「任务清单」系统提示小节（纯函数）。空清单 → ''（调用方不拼接）。
 * 渲染全部 50 项以内条目：`[x]/[>]/[ ] content`，进行中带 activeForm。
 */
export function renderPlanSection(todos) {
  const list = sanitizeTodos(todos);
  if (!list.length) return '';
  const lines = list.map((t) => {
    const mark = MARK[t.status] || '[ ]';
    const doing = t.status === 'in_progress' && t.activeForm ? `（进行中：${t.activeForm}）` : '';
    return `${mark} ${t.content}${doing}`;
  });
  return [
    '## 任务清单（你维护的 plan，跨压缩与重启保留；开始/完成一项时用 TodoWrite 更新，不要向用户复述本清单）',
    ...lines,
  ].join('\n');
}
