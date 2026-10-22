/**
 * 图片附件内联（openai 路径的多模态输入，2026-10-15）。
 *
 * 背景：web 输入框的附件（拖入/粘贴）发送时只序列化成「绝对路径文本」——Claude 路径靠
 * Claude Code 自带的 Read 工具能看图，自定义模型（openai-compat）的内置 Read 是纯文本工具
 * （二进制直接报错），附件里的图片对模型永远不可见。本模块在**模型边界**把显式的图片附件
 * 转成 AI SDK 的 file part（openai-compatible provider 映射成 image_url 的 data URL），
 * 其余附件仍以路径文本交给工具处理。
 *
 * 口径（拍板）：
 *  - 只处理消息上显式的 `attachments` 元数据（前端 chip 结构化上送）；不扫正文路径——
 *    正文里随手写的路径不是「用户要给我看的图」；
 *  - 类型判定按**魔数**（扩展名只用于决定要不要报「不是有效图片」），改名/无扩展名的图也认；
 *    非图片附件（pdf/代码…）静默放行，不产生噪音；
 *  - 只有最近 MAX_IMAGE_MESSAGES 条带附件的用户消息参与重放（本轮 + 上一轮追问），更早的
 *    只保留文本；另有单图体积 / 张数 / 单轮总量三重上限——图片在每步请求里都要重复计费；
 *  - 零 IO：`readFile`/`statFile` 由调用方注入（单测零磁盘）；`cache` 是 per-run 的 Map，
 *    同一张图多步重放只读一次盘；
 *  - 视图变换：返回的新消息会剥掉 `attachments` 元数据（不该发给模型）；落盘/压缩/检查点
 *    链路仍用原消息（含 attachments）。
 */
import path from 'node:path';

/** 图片扩展名 → MIME（缩略图/兼容提示用；真正的类型判定走魔数） */
export const IMAGE_MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
});

/** 单条消息的结构化附件上限（入参归一；前端 chip 再多也截到这） */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** 一次模型请求内联的图片张数上限 */
export const MAX_IMAGES_PER_REQUEST = 4;
/** 单张图片体积上限（原始字节） */
export const MAX_IMAGE_FILE_BYTES = 4 * 1024 * 1024;
/** 一次模型请求内联图片的总体积上限（原始字节） */
export const MAX_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
/** 回溯参与重放的「带图用户消息」条数（含当前轮；更早的只留文本） */
export const MAX_IMAGE_MESSAGES = 2;

/** 路径扩展名是否像图片（估算/报错归因用；不用于放行——放行看魔数） */
export function isImagePath(p) {
  const ext = path.extname(String(p || '')).slice(1).toLowerCase();
  return Boolean(IMAGE_MIME_BY_EXT[ext]);
}

/**
 * 附件列表归一（纯函数）：只认 `{path, name?}`（字符串 path 也接受），去空、去重、限量。
 * 去重按平台大小写规则（Windows 路径不区分大小写）；name 缺省取 basename。
 * @param {unknown} input 任意前端来参
 * @returns {Array<{path:string, name:string}>}
 */
export function normalizeAttachments(input, { max = MAX_ATTACHMENTS_PER_MESSAGE } = {}) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (out.length >= max) break;
    const rawPath = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.path : '';
    const clean = String(rawPath || '').trim();
    if (!clean) continue;
    const key = process.platform === 'win32' ? clean.toLowerCase() : clean;
    if (seen.has(key)) continue;
    seen.add(key);
    const rawName = raw && typeof raw === 'object' && typeof raw.name === 'string' ? raw.name.trim() : '';
    const name = (rawName || path.basename(clean) || clean).slice(0, 200);
    out.push({ path: clean, name });
  }
  return out;
}

/** 魔数嗅探图片类型（png/jpeg/gif/webp/bmp）；不是图片返回 null */
export function guessImageMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : buf instanceof Uint8Array ? Buffer.from(buf) : null;
  if (!b || b.length < 4) return null;
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
    return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * 缓存记账：{ok:false, reason, imageLike}=没发出去（imageLike 决定要不要报给用户），
 * {ok:true, data, mime}=可用图片。imageLike 指「看起来像图片」——扩展名或魔数任一命中。
 */
async function loadOne(absPath, { readFile, statFile, cache, maxImageBytes }) {
  const key = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  if (cache instanceof Map && cache.has(key)) return cache.get(key);
  const extHint = isImagePath(absPath);
  let entry;
  try {
    if (typeof statFile === 'function') {
      const st = await statFile(absPath);
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        entry = { ok: false, reason: '是目录', imageLike: false };
      } else if (Number(st?.size) > maxImageBytes) {
        // 超大文件不整读（可能是视频/压缩包）；扩展名是图片就报「超过上限」，否则静默
        entry = { ok: false, reason: `超过单张上限（${Math.round(maxImageBytes / 1024 / 1024)}MB）`, imageLike: extHint };
      }
    }
    if (!entry) {
      const buf = await readFile(absPath);
      const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      const mime = guessImageMime(data);
      if (!mime) entry = { ok: false, reason: '不是有效图片', imageLike: extHint };
      else if (data.length > maxImageBytes)
        entry = { ok: false, reason: `超过单张上限（${Math.round(maxImageBytes / 1024 / 1024)}MB）`, imageLike: true };
      else entry = { ok: true, data, mime };
    }
  } catch {
    entry = { ok: false, reason: '文件不存在或不可读', imageLike: extHint };
  }
  if (cache instanceof Map) cache.set(key, entry);
  return entry;
}

/**
 * 把消息里显式的图片附件内联成 AI SDK file part（模型边界视图变换）。
 *
 * @param {Array} messages ModelMessage 数组（agent-loop 的对话副本）
 * @param {object} [opts]
 * @param {(p:string)=>Promise<Buffer>} [opts.readFile] 缺省不内联（fail-safe：宁可不发，不猜）
 * @param {(p:string)=>Promise<{size?:number,isDirectory?:()=>boolean}>} [opts.statFile] 可选：先 stat 拦超大文件
 * @param {Map} [opts.cache] per-run 缓存（同一张图多步重放只读一次盘）
 * @param {number} [opts.maxImages] / [opts.maxImageBytes] / [opts.maxTotalBytes] / [opts.maxMessages] 上限覆盖（测试用）
 * @returns {{messages:Array, inlined:Array<{path,name,mime,bytes}>, skipped:Array<{path,name,reason}>}}
 *          无变化时 messages 为原引用；skipped 只含「像图片但没发出去」的条目（非图片附件静默放行）
 */
export async function inlineImageAttachments(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const { readFile, statFile, cache } = opts;
  const maxImages = Number.isFinite(opts.maxImages) ? opts.maxImages : MAX_IMAGES_PER_REQUEST;
  const maxImageBytes = Number.isFinite(opts.maxImageBytes) ? opts.maxImageBytes : MAX_IMAGE_FILE_BYTES;
  const maxTotalBytes = Number.isFinite(opts.maxTotalBytes) ? opts.maxTotalBytes : MAX_IMAGE_TOTAL_BYTES;
  const maxMessages = Number.isFinite(opts.maxMessages) ? opts.maxMessages : MAX_IMAGE_MESSAGES;
  if (typeof readFile !== 'function' || list.length === 0) return { messages: list, inlined: [], skipped: [] };

  // 1) 选出参与重放的带附件用户消息下标（从最新往前，最多 maxMessages 条）
  const targets = new Set();
  for (let i = list.length - 1; i >= 0 && targets.size < maxMessages; i--) {
    const m = list[i];
    if (m && m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) targets.add(i);
  }
  if (!targets.size) {
    // 没有带附件消息：仍要剥掉元数据？不会存在（targets 空 = 无人带）→ 原引用返回
    return { messages: list, inlined: [], skipped: [] };
  }

  const inlined = [];
  const skipped = [];
  const seenPaths = new Set(); // 同一张图只发一次（多条消息引用同一附件）
  const partsByIndex = new Map(); // 下标 → image part[]
  let imageCount = 0;
  let totalBytes = 0;

  // 2) 从最新一条往旧处理：预算优先给当前轮
  const order = [...targets].sort((a, b) => b - a);
  for (const i of order) {
    const msg = list[i];
    const atts = normalizeAttachments(msg.attachments, { max: MAX_ATTACHMENTS_PER_MESSAGE });
    const parts = [];
    for (const att of atts) {
      const key = process.platform === 'win32' ? att.path.toLowerCase() : att.path;
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      const entry = await loadOne(att.path, { readFile, statFile, cache, maxImageBytes });
      if (!entry.ok) {
        // 只有「看起来像图片」才报错——pdf/代码等非图片附件静默放行
        if (entry.imageLike) skipped.push({ path: att.path, name: att.name, reason: entry.reason });
        continue;
      }
      if (imageCount >= maxImages) {
        skipped.push({ path: att.path, name: att.name, reason: `超过本轮图片数量上限（${maxImages} 张）` });
        continue;
      }
      if (totalBytes + entry.data.length > maxTotalBytes) {
        skipped.push({ path: att.path, name: att.name, reason: `超过本轮图片总量上限（${Math.round(maxTotalBytes / 1024 / 1024)}MB）` });
        continue;
      }
      imageCount++;
      totalBytes += entry.data.length;
      parts.push({ type: 'file', data: entry.data, mediaType: entry.mime });
      inlined.push({ path: att.path, name: att.name, mime: entry.mime, bytes: entry.data.length });
    }
    if (parts.length) partsByIndex.set(i, parts);
  }

  if (!partsByIndex.size) {
    // 一张都没内联成功：仍要把 attachments 元数据从模型视图剥掉（它是本地账，不是给模型的）
    return { messages: list.map(stripAttachmentsIfAny), inlined, skipped };
  }

  const out = list.map((m, i) => {
    const parts = partsByIndex.get(i);
    if (!parts) return stripAttachmentsIfAny(m);
    const text = typeof m.content === 'string' ? m.content : '';
    const content = [...(text ? [{ type: 'text', text }] : []), ...parts];
    return { ...m, content, attachments: undefined };
  });
  // attachments: undefined 会在 JSON 里消失，但对象仍带键——统一删干净，保持视图整洁
  for (const m of out) if (m && 'attachments' in m && m.attachments === undefined) delete m.attachments;
  return { messages: out, inlined, skipped };
}

function stripAttachmentsIfAny(m) {
  if (!m || typeof m !== 'object' || !('attachments' in m)) return m;
  const rest = { ...m };
  delete rest.attachments;
  return rest;
}
