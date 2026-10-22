/**
 * follow-up 队列落盘（P1-9，spec `docs/superpowers/specs/2026-10-11-followup-persistence-and-plan-design.md`）。
 *
 * 语义：openai 路径同 conv 有 running run 时，新消息排队（busy inbox，见 runs.js）——
 * 本模块把队列的三个状态迁移（enqueue / cancel / take）经 `runs.js` 的 sink 单向镜像到
 * `conv-followups.json`；读方只有启动恢复（`entrypoints/web/conv-inbox.js#restoreFollowUpInbox`，
 * hydrate 回内存后对空闲 conv 补排空）。
 *
 * 形状：`{ v:1, convs: { [convId]: item[] } }`，item 形状见 `runs.js#buildFollowUpItem`
 * （含全部起跑快照：provider/model/effort/mode/credId/cwd/ultracode…；恢复排空靠它，不能裁剪）。
 *
 * 失败纪律：本层照例**损坏拒写、抛错**（store 惯例）；吞错与日志在上层接线（run-durability / conv-inbox）。
 * enqueue 按 id 幂等去重（sink 重放 / 重复投递不改盘）；cancel/take 对不存在项 no-op（不写盘）。
 */
import { readJson, updateJson, writeJson } from './index.js';

const FILE = 'conv-followups.json';
const empty = () => ({ v: 1, convs: {} });

/**
 * 应用一次队列迁移（sink 的落点）。
 * @param {{type:'enqueue'|'cancel'|'take', convId:string, item?:object, id?:string}} op
 * @returns {{changed:boolean}} 是否真的改盘（no-op 时 updateJson 放弃写）
 */
export function applyFollowUpOp(op = {}) {
  const { type, convId, item, id } = op && typeof op === 'object' ? op : {};
  if (!convId || !['enqueue', 'cancel', 'take'].includes(type)) return { changed: false };
  let changed = false;
  updateJson(FILE, empty(), (cur) => {
    const convs = { ...(cur && cur.convs && typeof cur.convs === 'object' ? cur.convs : {}) };
    const list = Array.isArray(convs[convId]) ? [...convs[convId]] : [];
    if (type === 'enqueue') {
      if (!item || typeof item !== 'object' || !item.id) return undefined;
      if (list.some((m) => m && m.id === item.id)) return undefined; // 幂等：同一排队项不重复落
      list.push({ ...item });
      convs[convId] = list;
    } else if (type === 'cancel') {
      const next = list.filter((m) => !(m && m.id === id));
      if (next.length === list.length) return undefined;
      if (next.length) convs[convId] = next;
      else delete convs[convId];
    } else {
      if (!convs[convId]) return undefined;
      delete convs[convId];
    }
    changed = true;
    return { v: 1, convs };
  });
  return { changed };
}

/** 全量队列（恢复用）：`{ [convId]: item[] }` 深拷贝一层；无文件返回空对象 */
export function readAllFollowUps() {
  const state = readJson(FILE, empty());
  const convs = state && typeof state === 'object' && state.convs && typeof state.convs === 'object' ? state.convs : {};
  const out = {};
  for (const [convId, list] of Object.entries(convs)) {
    if (!Array.isArray(list) || !list.length) continue;
    const items = list.filter((m) => m && typeof m === 'object').map((m) => ({ ...m }));
    if (items.length) out[convId] = items;
  }
  return out;
}

/** 清空（测试/运维用） */
export function clearAllFollowUps() {
  writeJson(FILE, empty());
}
