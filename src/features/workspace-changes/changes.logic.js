/**
 * 「未提交改动了什么」的纯逻辑层 —— 零 IO、零 fs、零 LLM。
 *
 * ## 基线是什么
 *
 * **HEAD**：工作区（已暂存 + 未暂存）相对最后一次提交的差异，也就是 git 眼里的「未提交」。
 * 已跟踪文件的 hunk 直接解析 `git diff HEAD` 的输出（子进程在 collect.js），
 * 未跟踪文件（`git ls-files --others`）没有 HEAD 版本，按「空文件 → 盘上内容」用 jsdiff 算。
 *
 * ## 为什么换掉了原来那套「扫会话转录」
 *
 * 老实现（2026-10 的 session-changes）只认转录里的 Edit / MultiEdit / Write，内容是靠
 * **反向重放**自证 + `file-history` 快照 + 片段模式三级降级猜出来的：猜得中就出带行号的
 * diff，猜不中就只能给一堆没有行号的片段。而且它绑死在「当前这个会话」上 —— 换个窗口、
 * 换条分支、或者文件在会话结束后又被谁动过，口径立刻对不上。
 *
 * git 手里有精确的 before/after，于是三级降级、片段模式、逐文件基线标注整套复杂度都不必存在，
 * 行号也永远是真的。代价只有一个，且是刻意接受的：**不再区分是谁改的** —— 上一轮会话改的、
 * 维护者手改的、别的工具改的都会算进来。审计「我这一摊现在有哪些没提交的东西」时，
 * 这恰恰是想要的口径。
 *
 * ## 已知边界（刻意保留，不修）
 *
 * - 二进制文件只有「变了」这个事实，没有 hunk：编造一版内容只会在面板上糊成乱码。
 * - 只看工作区：已提交的东西不在「未提交」的语义里，哪怕是刚提交的。
 */

import { structuredPatch, diffWordsWithSpace } from 'diff';

/** 单个文件 before+after 的字符数上限：超过就不做 diff（对比结果会大到不适合走 HTTP） */
export const MAX_TEXT_BYTES = 512 * 1024;

/** 单文件最多下发多少行 hunk：超出的部分截断，宁可少给也不让一次响应变成几 MB */
export const MAX_ROWS_PER_FILE = 3000;

/** 一次响应最多带多少个文件：仓库大改（如全量格式化 / 没进 .gitignore 的 node_modules）时兜住响应体 */
export const MAX_FILES = 300;

/** 一次响应最多下发多少行 hunk（所有文件共享的预算）。单文件的 MAX_ROWS_PER_FILE 管不住总量 */
export const MAX_TOTAL_ROWS = 20_000;

/** jsdiff 的编辑距离预算：超时返回 undefined，调用方降级成「不给 diff」 */
const DIFF_TIMEOUT_MS = 3000;

/** hunk 上下文行数，与 git 默认一致 */
export const CONTEXT_LINES = 3;

/** 词级强调的阈值：一行里改动字符占比超过它就不逐词标红，避免整行糊成一片 */
const EMPHASIS_MAX_RATIO = 0.7;

/** 按行切开，**末尾换行不算一个空行**。`'a\nb\n'` → `['a','b']`；`''` → `[]`。 */
export function splitLines(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 行数（与 splitLines 同口径，空文件 0 行） */
export function countLines(text) {
  return splitLines(text).length;
}

// ==================== 完整内容 → hunk（未跟踪文件走这条） ====================

/**
 * 完整 before/after → git 式 hunk 列表（含行号）。
 *
 * @param {string} before
 * @param {string} after
 * @returns {{hunks:Array, added:number, removed:number, oldTotal:number, newTotal:number, truncated:boolean}|null}
 *          规模超限 / diff 超时时返回 null（调用方只报「改了」不给内容）
 */
export function buildUnifiedDiff(before, after) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  if (a.length + b.length > MAX_TEXT_BYTES) return null;

  const patch = structuredPatch('a', 'b', a, b, '', '', {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (!patch || !Array.isArray(patch.hunks)) return null; // 超时 → jsdiff 返回 undefined

  const hunks = [];
  let added = 0;
  let removed = 0;
  let sentRows = 0;
  let truncated = false;
  for (const h of patch.hunks) {
    const { rows, added: a2, removed: r } = hunkRows(h);
    added += a2;
    removed += r;
    if (sentRows + rows.length > MAX_ROWS_PER_FILE) {
      truncated = true; // 行数与 hunk 头仍按全量统计，只是不再往下发
      break;
    }
    sentRows += rows.length;
    hunks.push({
      header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      rows,
    });
  }
  return { hunks, added, removed, truncated, oldTotal: countLines(a), newTotal: countLines(b) };
}

/**
 * 一个 hunk 的原始行 → 带双列行号的行数组，并就地补上词级强调。
 *
 * `\ No newline at end of file` 是**标记行**不是内容行，它不占行号，挂到上一条上让前端渲染成提示。
 * 入参形状与 jsdiff 的 structuredPatch 输出、以及 parseGitPatch 里现拼的 rawHunk 完全一致 ——
 * 两条来源（jsdiff / git）共用这一段，词级强调才不会各写一份。
 */
function hunkRows(hunk) {
  const rows = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let added = 0;
  let removed = 0;

  for (const raw of hunk.lines) {
    const t = raw[0];
    const text = raw.slice(1);
    if (t === '\\') {
      // 跟在最后一条内容行后面，标记那一侧没有末尾换行
      const last = rows[rows.length - 1];
      if (last) last.noEol = true;
      continue;
    }
    if (t === '+') {
      rows.push({ t: '+', oldNo: null, newNo: newNo++, text });
      added++;
    } else if (t === '-') {
      rows.push({ t: '-', oldNo: oldNo++, newNo: null, text });
      removed++;
    } else {
      rows.push({ t: ' ', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  emphasize(rows);
  return { rows, added, removed };
}

// ==================== git diff 输出 → hunk ====================

/** `@@ -1,3 +1,4 @@`（省略计数时表示 1 行，git 会省掉 `,1`） */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 去掉 diff 里的 `a/` `b/` 前缀，`/dev/null` 返回 null（新增 / 删除的那一侧）。
 * 路径含特殊字符时 git 会用 C 风格引号包起来，这里解回原样。
 */
export function diffPath(raw) {
  let p = String(raw ?? '').trim();
  if (!p) return null;
  if (p.startsWith('"')) {
    try {
      p = JSON.parse(p); // git 的引号规则与 JSON 字符串字面量一致
    } catch {
      p = p.replace(/^"|"$/g, '');
    }
  }
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

/**
 * `git diff HEAD` 的输出 → 每个文件一条改动记录（纯函数，便于单测）。
 *
 * 刻意不解析 `diff --git a/x b/y` 那一行取路径：重命名时它是 `a/旧 b/新`，空格与引号
 * 都可能是路径的一部分，切不干净；`---`/`+++`/`rename to` 每行只有一个路径，可靠得多。
 *
 * @param {string} text git diff 的 stdout
 * @returns {Array<object>} 形状见 fileEntry；**不含未跟踪文件**（那类没有 HEAD 版本）
 */
export function parseGitPatch(text) {
  const blocks = [];
  let b = null;
  let h = null;

  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      b = { gitLine: line, path: '', oldPath: '', kind: 'modify', binary: false, modeChanged: false, rawHunks: [] };
      h = null;
      blocks.push(b);
      continue;
    }
    if (!b) continue;

    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      h = {
        // 计数省略即 1（`@@ -0,0 +1 @@`）
        oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      b.rawHunks.push(h);
      continue;
    }
    if (line.startsWith('rename from ')) { b.kind = 'rename'; b.oldPath = diffPath(line.slice(12)) || ''; continue; }
    if (line.startsWith('rename to ')) { b.kind = 'rename'; b.path = diffPath(line.slice(10)) || ''; continue; }
    if (line.startsWith('copy from ')) { b.oldPath = diffPath(line.slice(10)) || ''; continue; }
    if (line.startsWith('copy to ')) { b.path = diffPath(line.slice(8)) || ''; continue; }
    if (line.startsWith('new file mode ')) { b.kind = 'add'; continue; }
    if (line.startsWith('deleted file mode ')) { b.kind = 'delete'; continue; }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) { b.modeChanged = true; continue; }
    // 二进制文件在 diff 里只有这一行，没有 `---`/`+++`：路径只能从这里取。
    // 贪婪匹配第一个分组，于是「路径里含 ` and `」时切在最后一个 ` and ` 上，切不错。
    const bin = /^Binary files (.+) and (.+) differ$/.exec(line);
    if (bin) {
      b.binary = true;
      const from = diffPath(bin[1]);
      const to = diffPath(bin[2]);
      if (from) b.oldPath = from;
      else if (b.kind === 'modify') b.kind = 'add'; // `/dev/null` 那一侧说明它是这次新增的
      if (to) b.path = to;
      else if (b.kind === 'modify') b.kind = 'delete';
      continue;
    }
    if (line === 'GIT binary patch') { b.binary = true; continue; }
    if (line.startsWith('--- ')) {
      const p = diffPath(line.slice(4));
      if (p) b.oldPath = p;
      else b.kind = 'add'; // --- /dev/null：这个文件是这次新增的
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = diffPath(line.slice(4));
      if (p) b.path = p;
      else b.kind = 'delete'; // +++ /dev/null
      continue;
    }
    // index / similarity index / dissimilarity index 这类头部行没有信息量，跳过。
    // `\ No newline at end of file` 原样收进去 —— hunkRows 认得它（不占行号、挂到上一条上）。
    // 空串只可能来自「整行就是一个空格的上下文行」被 stdout trim 吃掉的情况，
    // hunk 内部不可能有别的空行，按空上下文行补回来。
    if (h) h.lines.push(line === '' ? ' ' : line);
  }

  for (const x of blocks) {
    // 纯权限变更这类块只有 `diff --git` 一行头部，没有 `---`/`+++` 可取值
    if (!x.path && !x.oldPath) x.path = pathFromDiffGit(x.gitLine);
  }

  return blocks
    // 既没有路径也没有内容的块（异常输出）直接丢掉，别在列表里留个空条目
    .filter((x) => x.path || x.oldPath)
    .map((x) => entryFromBlock(x));
}

/**
 * 从 `diff --git a/x b/y` 这行取路径（**兜底**，只在没有 `---`/`+++` 可用时走）。
 *
 * 这行天然有歧义：路径里可以含 ` b/`，单靠字符串切不出边界。所以切两刀（贪婪 / 非贪婪）
 * 并要求两侧结果相同才认 —— 非重命名的块两侧本来就是同一个路径，两边一致即证明切对了。
 * 都对不上就返回空串（宁可少一条，也不拿切错的路径去骗人）。
 */
export function pathFromDiffGit(line) {
  const body = String(line || '').slice('diff --git '.length);
  for (const re of [/^a\/(.*) b\/(.*)$/, /^a\/(.*?) b\/(.*)$/]) {
    const m = re.exec(body);
    if (m && m[1] === m[2]) return m[1];
  }
  return '';
}

function entryFromBlock(b) {
  const hunks = [];
  let added = 0;
  let removed = 0;
  let sentRows = 0;
  let truncated = false;

  for (const raw of b.rawHunks) {
    const { rows, added: a, removed: r } = hunkRows(raw);
    added += a;
    removed += r;
    if (sentRows + rows.length > MAX_ROWS_PER_FILE) {
      truncated = true;
      continue; // 计数照收，只是不再下发这一段
    }
    sentRows += rows.length;
    hunks.push({
      header: `@@ -${raw.oldStart},${raw.oldLines} +${raw.newStart},${raw.newLines} @@`,
      oldStart: raw.oldStart,
      oldLines: raw.oldLines,
      newStart: raw.newStart,
      newLines: raw.newLines,
      rows,
    });
  }

  const kind = b.kind;
  return {
    path: b.path || b.oldPath,
    // 重命名要能看出从哪来；其余情况等于 path（前端不额外判空）
    oldPath: kind === 'rename' ? (b.oldPath || '') : '',
    kind,
    added,
    removed,
    deleted: kind === 'delete',
    binary: b.binary,
    // 只有权限位变了：没有任何 hunk，但确实是未提交改动，得让人看见
    modeOnly: !b.binary && b.modeChanged && b.rawHunks.length === 0,
    // 行号是 git 给的，永远精确；前端据 diffMode 决定画 hunk 还是画一句说明
    diffMode: 'unified',
    hunks,
    // git diff 不报文件总行数：尾部那条「N 行未修改」分隔条因此画不出来，
    // 用 0 表示「不知道」（diffSegments 对 0 会自然跳过，不会画出负数）
    oldTotal: 0,
    newTotal: 0,
    truncated,
  };
}

/**
 * 「有这条改动，但不给内容」的一条记录：二进制文件、过大文件都走这里。
 * 编造一版内容是错的 —— 面板上糊成乱码比如实说「看不了」更糟。
 */
export function noDiffEntry(path, { kind = 'add', binary = false, tooLarge = false } = {}) {
  return {
    path,
    oldPath: '',
    kind,
    added: 0,
    removed: 0,
    deleted: kind === 'delete',
    binary,
    modeOnly: false,
    diffMode: 'none',
    tooLarge,
    hunks: [],
    oldTotal: 0,
    newTotal: 0,
    truncated: false,
  };
}

/**
 * 未跟踪文件一条：没有 HEAD 版本，before 就是空。
 * @param {string} path cwd 相对路径
 * @param {string} text 盘上内容
 * @returns {object} 形状同 entryFromBlock
 */
export function newFileEntry(path, text) {
  const diff = buildUnifiedDiff('', text);
  // 内容过大或 diff 超时：如实报「是个新增文件」，但不编造内容
  if (!diff) return noDiffEntry(path, { kind: 'add', tooLarge: true });
  return {
    path,
    oldPath: '',
    kind: 'add',
    deleted: false,
    binary: false,
    modeOnly: false,
    diffMode: 'unified',
    tooLarge: false,
    ...diff,
  };
}

// ==================== 行内词级强调 ====================

/**
 * 词级强调：把「一段删除 + 紧接着一段插入」按行配对，算出行内哪几个词真的变了。
 *
 * 不给整行上色：一行的改动通常只占几个字符，整行标红会让人看不出改了哪儿。
 * 改动占比过大（>70%）时整对放弃强调 —— 那本质上是「换了一行」，逐词标注只会糊成一片。
 */
function emphasize(rows) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t !== '-') { i++; continue; }
    let d = i;
    while (d < rows.length && rows[d].t === '-') d++;
    let a = d;
    while (a < rows.length && rows[a].t === '+') a++;
    if (d === i || a === d) { i = Math.max(a, i + 1); continue; }

    const pairs = Math.min(d - i, a - d);
    for (let k = 0; k < pairs; k++) {
      const del = rows[i + k];
      const add = rows[d + k];
      const segs = wordSegments(del.text, add.text);
      if (!segs) continue;
      del.segs = segs.old;
      add.segs = segs.new;
    }
    i = a;
  }
}

/**
 * 两行的词级差异 → 两侧各自的片段数组。
 * @returns {{old:Array<{text:string,em:boolean}>, new:Array}|null} 差异过大时不强调
 */
export function wordSegments(oldLine, newLine) {
  const parts = diffWordsWithSpace(String(oldLine ?? ''), String(newLine ?? ''));
  let changed = 0;
  let total = 0;
  for (const p of parts) {
    const n = p.value.length;
    total += n;
    if (p.added || p.removed) changed += n;
  }
  if (!total || changed / total > EMPHASIS_MAX_RATIO) return null;

  const oldSegs = [];
  const newSegs = [];
  for (const p of parts) {
    if (p.removed) oldSegs.push({ text: p.value, em: true });
    else if (p.added) newSegs.push({ text: p.value, em: true });
    else {
      oldSegs.push({ text: p.value, em: false });
      newSegs.push({ text: p.value, em: false });
    }
  }
  return { old: oldSegs, new: newSegs };
}

// ==================== 聚合 ====================

/**
 * 行数预算：按顺序吃掉各文件的 hunk 行，超预算的那些**不再下发内容**（计数仍是全量的）。
 *
 * 单文件的 MAX_ROWS_PER_FILE 挡得住一个巨型文件，挡不住「300 个文件 × 各 3000 行」；
 * 前端 5s 一轮询，那种响应体每次都要重新解析。超出时整份文件的 hunk 一起撤掉而不是切一半：
 * 半份 diff 看着像完整的一页，反而更容易被误读成「这文件就这么点改动」。
 */
export function applyRowBudget(files, budget = MAX_TOTAL_ROWS) {
  let left = budget;
  return files.map((f) => {
    const rows = f.hunks.reduce((n, h) => n + h.rows.length, 0);
    if (rows <= left) {
      left -= rows;
      return f;
    }
    left = 0;
    return { ...f, hunks: [], truncated: true, diffMode: f.diffMode === 'unified' ? 'none' : f.diffMode };
  });
}

/**
 * 内容指纹（FNV-1a 32 位，十六进制串）。
 *
 * 前端 5s 一轮询，靠它判断「这一轮拿到的和上一轮是不是同一份」——只比增删行数是不够的：
 * 把 `bar(x)` 改成 `baz(x)`，改动的行数一个没变，面板却必须重画。
 */
export function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV 质数 16777619，用移位乘法避免 32 位溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/** 改动量倒序（审计时先看的就是动得最狠的地方），同量按路径排 */
export function sortFileEntries(files) {
  return [...files].sort(
    (a, b) => (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path),
  );
}

/**
 * 目录树（「修改的内容地图」的数据源）：目录节点带子树汇总，叶子是文件。
 *
 * 与改动列表不同源但同料——列表回答「改了哪些文件」，树回答「改动落在项目的哪个部位」。
 */
export function buildChangeTree(files) {
  const root = makeDir('', '');
  for (const f of files) {
    const segs = String(f.path).split('/').filter(Boolean);
    if (!segs.length) continue;
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const isLeaf = i === segs.length - 1;
      const path = segs.slice(0, i + 1).join('/');
      if (isLeaf) {
        node.children.push({
          type: 'file',
          name: segs[i],
          path,
          added: f.added,
          removed: f.removed,
          kind: f.kind,
          deleted: !!f.deleted,
          files: 1,
        });
      } else {
        let dir = node.children.find((c) => c.type === 'dir' && c.name === segs[i]);
        if (!dir) {
          dir = makeDir(segs[i], path);
          node.children.push(dir);
        }
        node = dir;
      }
    }
  }
  rollup(root);
  sortTree(root);
  return root;
}

function makeDir(name, path) {
  return { type: 'dir', name, path, added: 0, removed: 0, files: 0, children: [] };
}

/** 自底向上汇总：目录节点累加所有后代 */
function rollup(node) {
  if (node.type !== 'dir') return;
  node.added = 0;
  node.removed = 0;
  node.files = 0;
  for (const child of node.children) {
    rollup(child);
    node.added += child.added;
    node.removed += child.removed;
    node.files += child.type === 'file' ? 1 : child.files;
  }
}

/** 目录在前按名排、文件在后按改动量倒序：地图上「动得多」的叶子聚在底部，扫一眼就有重心 */
function sortTree(node) {
  if (node.type !== 'dir') return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (a.type === 'dir') return a.name.localeCompare(b.name);
    return b.added + b.removed - (a.added + a.removed) || a.name.localeCompare(b.name);
  });
  for (const child of node.children) sortTree(child);
}

/** 汇总计数（面板头部的「N 个文件 · +A / -R」） */
export function summarizeFiles(files) {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { files: files.length, added, removed };
}

/** 把完整结果削成徽标用的摘要（同一个结果切片，不重新计算） */
export function summarizeResult(result) {
  return {
    ok: true,
    cwd: result.cwd,
    empty: result.empty,
    reason: result.reason,
    summary: result.summary,
  };
}
