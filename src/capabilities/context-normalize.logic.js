/**
 * 发送前上下文 normalize 纯函数层（P0-③，spec `docs/superpowers/specs/2026-10-11-send-time-context-normalize-design.md`）。
 *
 * 解决的问题：交给模型的序列必须满足一组不变量——每个 tool-call 有对应 tool-result、
 * 无孤立 tool-result、无空消息。改动前这件事散在两处、各管一段：`entrypoints/web/run-openai.logic.js#repairDanglingToolCalls`
 * 只补配对缺口，`entrypoints/web/conv-compact.logic.js#dropLeadingOrphans` 只管头部孤立结果，
 * `clipMiddle` 只服务摘要输入。本层把它们收成**一组发送前必跑的不变量**（对标 Codex
 * `ContextManager::for_prompt` 发送前必过 normalize：`ensure_call_outputs_present` / `remove_orphan_outputs`），
 * 并按 Codex「截断有策略」把单条超长消息的中间截断也收进来（保存头尾、丢中间）。
 *
 * 口径（拍板）：
 *  - 配对是**就近**的：tool-result 只有紧跟（可跨多条 tool 消息、允许批内乱序）在本批待答调用后才算数；
 *    结果存在但位置脱档（历史脏数据）时**前拉**到调用后（保留真实结果），找不到才合成「未执行」占位；
 *  - 孤立 tool-result（无对应调用/重复结果）从视图剔除，**不落盘**——存储是全量账本，视图才是发送面；
 *  - 空 assistant/tool 消息剪除；user/system 不剪（输入端约束由调用方负责，静默吞掉触发消息更糟）；
 *  - 超长单条消息中间截断（默认 120k 字符，高于所有工具层硬上限，只挡病态数据）。
 * 零 IO；调用点：`entrypoints/web/run-openai.js`（载入历史时修复落盘 + 构建请求前的防御性终检）。
 */

/** 合成结果的固定文案（缺口 = 进程中断时该调用从未执行；模型看到后可自行决定重试） */
export const DEFAULT_UNEXECUTED_NOTE = '进程中断，该工具未执行';

/** 单条消息内容的发送上限（字符）：高于所有工具层硬上限（WebFetch 100k / Read 50KB / Bash 30k），只挡病态数据 */
export const DEFAULT_MAX_ITEM_CHARS = 120_000;

/**
 * 中间截断：保头 60% / 尾 40%，中间以省略标记替代（P0 从 conv-compact 迁来，摘要格式化与发送面共用）。
 * 省略标记格式与旧实现逐字一致（测试与用户排障都认它）。
 */
export function clipMiddle(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return str.slice(0, head) + `\n…（略 ${str.length - max} 字符）…\n` + str.slice(-tail);
}

/**
 * 消息序列不变量（配对 + 孤立清理）。纯函数、不改原数组；无变化时原引用返回（零开销）。
 *
 * 算法（单趟 + 预索引）：
 *  - pending = 当前 assistant 批次的待答调用；进入任何非 tool 消息前先把 pending 结清：
 *    结果在后续消息里存在（脱档）→ 前拉一条单 part tool 消息插到调用后；不存在 → 合成「未执行」；
 *  - tool 消息里的 result part：toolCallId 在 pending 中 → 配对保留；否则（无调用/重复/已被前拉）剔除；
 *    整条被剔空则丢消息；非 result part 原样保留；
 *  - 非对象条目直接从视图剔除（损坏数据，不可发送也不可判形态）。
 *
 * @param {Array} messages ModelMessage 数组
 * @param {{note?:string}} [opts] note = 合成结果文案
 * @returns {{messages:Array, added:Array, stats:{synthesized:number, droppedOrphans:number, moved:number}}}
 *          added = 合成的 tool-result 消息（供调用方落盘；前拉/剔除/剪空都不落盘）
 */
export function normalizeSequence(messages, { note = DEFAULT_UNEXECUTED_NOTE } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, added: [], stats: { synthesized: 0, droppedOrphans: 0, moved: 0 } };
  }
  // 预索引：toolCallId → 结果 part 的出现位置（按出现序），供「脱档前拉」
  const occurrences = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (let j = 0; j < m.content.length; j++) {
      const p = m.content[j];
      if (!p || p.type !== 'tool-result' || !p.toolCallId) continue;
      const list = occurrences.get(p.toolCallId) || [];
      list.push({ i, j });
      occurrences.set(p.toolCallId, list);
    }
  }
  const consumed = new Set(); // `${i}:${j}` 已被配对/前拉消费的 result part
  const out = [];
  const added = [];
  const stats = { synthesized: 0, droppedOrphans: 0, moved: 0 };
  let pending = []; // [{ toolCallId, toolName }]
  let changed = false;

  /** 结清 pending：结清前不产出任何其它消息（保证调用后直接跟结果） */
  const settlePending = (beforeIdx) => {
    while (pending.length) {
      const call = pending.shift();
      const occ = (occurrences.get(call.toolCallId) || []).find(
        (o) => !consumed.has(`${o.i}:${o.j}`) && o.i >= beforeIdx,
      );
      if (occ) {
        consumed.add(`${occ.i}:${occ.j}`);
        out.push({ role: 'tool', content: [messages[occ.i].content[occ.j]] });
        stats.moved++;
      } else {
        const msg = {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: note } },
          ],
        };
        out.push(msg);
        added.push(msg);
        stats.synthesized++;
      }
      changed = true;
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      changed = true; // 损坏条目：剔除
      continue;
    }
    if (m.role === 'assistant') {
      settlePending(i); // 上一批未结清的调用，必须先于本条结清
      out.push(m);
      pending = (Array.isArray(m.content) ? m.content : [])
        .filter((p) => p && p.type === 'tool-call' && p.toolCallId)
        .map((p) => ({ toolCallId: p.toolCallId, toolName: p.toolName }));
      continue;
    }
    if (m.role === 'tool') {
      if (!Array.isArray(m.content)) {
        out.push(m); // 无 part 形态的 tool 消息交给剪空步骤
        continue;
      }
      const kept = [];
      let dropped = 0;
      let skipped = 0;
      for (let j = 0; j < m.content.length; j++) {
        const p = m.content[j];
        if (!p || p.type !== 'tool-result' || !p.toolCallId) {
          kept.push(p);
          continue;
        }
        if (consumed.has(`${i}:${j}`)) {
          skipped++; // 已被前拉（不能留在原消息里，否则重复）
          continue;
        }
        const k = pending.findIndex((c) => c.toolCallId === p.toolCallId);
        if (k >= 0) {
          consumed.add(`${i}:${j}`);
          pending.splice(k, 1);
          kept.push(p);
        } else {
          dropped++; // 无对应调用 / 重复结果
        }
      }
      if (!kept.length) {
        stats.droppedOrphans += dropped;
        changed = true; // 整条被剔空（含「全部前拉走」）→ 丢消息
        continue;
      }
      if (dropped || skipped) {
        stats.droppedOrphans += dropped;
        changed = true;
        out.push({ ...m, content: kept });
      } else {
        out.push(m);
      }
      continue;
    }
    settlePending(i); // user / system 等消息之前同理
    out.push(m);
  }
  settlePending(messages.length); // 尾部悬空的调用 → 合成补在末尾
  if (!changed) return { messages, added: [], stats: { synthesized: 0, droppedOrphans: 0, moved: 0 } };
  return { messages: out, added, stats };
}

/** 空消息判定：无可发送内容（非对象 / 缺 content / 空串 / 空数组）。user/system 是权威输入，不剪 */
function isEmptyMessage(m) {
  if (!m || typeof m !== 'object') return true;
  if (m.role !== 'assistant' && m.role !== 'tool') return false;
  const c = m.content;
  if (c == null) return true;
  if (typeof c === 'string') return c.trim() === '';
  if (Array.isArray(c)) return c.length === 0;
  return false;
}

/**
 * 剪空消息（只剪 assistant/tool 的无可发送内容消息）。
 * 空 user/system 不剪：那是输入端的事，静默吞掉触发消息比多发一条空消息更糟。
 * @returns {{messages:Array, dropped:number}} 无变化时原引用
 */
export function pruneEmptyMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let dropped = 0;
  const kept = [];
  for (const m of list) {
    if (isEmptyMessage(m)) {
      dropped++;
      continue;
    }
    kept.push(m);
  }
  return dropped ? { messages: kept, dropped } : { messages: list, dropped: 0 };
}

/** 单 part 截断：字符串负载就地截（保类型）；json 大对象序列化后降级为 text/error-text */
function trimPart(part, limit) {
  if (!part || typeof part !== 'object') return part;
  if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
    const t = clipMiddle(part.text, limit);
    return t === part.text ? part : { ...part, text: t };
  }
  if (part.type !== 'tool-result') return part;
  const o = part.output;
  if (typeof o === 'string') {
    const t = clipMiddle(o, limit);
    return t === o ? part : { ...part, output: t };
  }
  if (o && typeof o === 'object' && typeof o.value === 'string') {
    const t = clipMiddle(o.value, limit);
    return t === o.value ? part : { ...part, output: { ...o, value: t } };
  }
  if (o && typeof o === 'object' && o.value != null && (o.type === 'json' || o.type === 'error-json')) {
    let json;
    try {
      json = JSON.stringify(o.value);
    } catch {
      return part; // 不可序列化（循环引用等）：不猜
    }
    if (json.length <= limit) return part;
    // 截断后已不是合法 JSON，如实降级为文本（AI SDK 两种 output 形态都接受）
    return {
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: { type: o.type === 'error-json' ? 'error-text' : 'text', value: clipMiddle(json, limit) },
    };
  }
  return part;
}

/**
 * 超长单条消息的中间截断（发送面专用，不落盘）。按 part 计：text/reasoning 的文本、
 * tool-result 的字符串负载 / json 大对象（序列化后降级 text）；tool-call 参数与未知 part 不动
 * （调用参数是历史事实陈述，且各工具 schema 已自限）。无变化时原引用返回。
 * @param {{maxChars?:number}} [opts] 非有限/非正值 = 不截（`Infinity` 即关闭）
 * @returns {{messages:Array, trimmed:number}} trimmed = 被截的 part 数
 */
export function trimLargeParts(messages, { maxChars = DEFAULT_MAX_ITEM_CHARS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return { messages: list, trimmed: 0 };
  let trimmed = 0;
  let changedAny = false;
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') {
      out.push(m);
      continue;
    }
    const c = m.content;
    if (typeof c === 'string') {
      const t = clipMiddle(c, limit);
      if (t === c) out.push(m);
      else {
        trimmed++;
        changedAny = true;
        out.push({ ...m, content: t });
      }
      continue;
    }
    if (!Array.isArray(c)) {
      out.push(m);
      continue;
    }
    let changed = false;
    const parts = c.map((p) => {
      const q = trimPart(p, limit);
      if (q !== p) {
        changed = true;
        trimmed++;
      }
      return q;
    });
    if (!changed) out.push(m);
    else {
      changedAny = true;
      out.push({ ...m, content: parts });
    }
  }
  return changedAny ? { messages: out, trimmed } : { messages: list, trimmed: 0 };
}

/**
 * 发送前不变量集（唯一组合点）：配对 → 剪空 → 截断。
 * 每个子步骤都「无变化原引用返回」，干净序列整体零开销（原引用 + 零 stats）。
 *
 * @param {Array} messages ModelMessage 数组（视图，非存储）
 * @param {{note?:string, maxItemChars?:number}} [opts]
 * @returns {{messages:Array, added:Array, stats:{synthesized:number, droppedOrphans:number, moved:number, droppedEmpty:number, trimmed:number}}}
 */
export function normalizeForModel(messages, { note = DEFAULT_UNEXECUTED_NOTE, maxItemChars = DEFAULT_MAX_ITEM_CHARS } = {}) {
  const seq = normalizeSequence(messages, { note });
  const pruned = pruneEmptyMessages(seq.messages);
  const trimmed = trimLargeParts(pruned.messages, { maxChars: maxItemChars });
  return {
    messages: trimmed.messages,
    added: seq.added,
    stats: { ...seq.stats, droppedEmpty: pruned.dropped, trimmed: trimmed.trimmed },
  };
}
