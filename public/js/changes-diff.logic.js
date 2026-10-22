/**
 * diff 视图的排布逻辑（纯函数，带单测）。
 *
 * 后端下发的是与 git 一致的 hunk 结构（oldStart/oldLines/newStart/newLines + 带双列行号的行）。
 * 「怎么摆」是前端的事，这里只算两件与 DOM 无关的事：
 *
 *   1. `diffSegments` —— hunk 之间那些**没展示的上下文行**有多少，好在中间插一条
 *      「⋯ 共 N 行未修改 ⋯」的分隔条（git / GitHub / VS Code 都是这么收的）。
 *   2. `toSplitRows` —— 并排视图要把「一段删除 + 紧接着的一段插入」按行配对，
 *      配不满的一侧留空行。这个配对规则是并排视图唯一容易错的地方，所以单独可测。
 */

/**
 * 把 hunk 序列展开成「分隔条 + hunk」的渲染项。
 *
 * 首尾的空白区也要算：只有第一个 hunk 从第 50 行开始、或最后一个 hunk 之后还有几百行，
 * 不画分隔条就会让人误以为文件只有这么多行。
 *
 * @param {{hunks:Array, oldTotal:number}} file
 * @returns {Array<{type:'gap', lines:number}|{type:'hunk', hunk:object}>}
 */
export function diffSegments({ hunks, oldTotal } = {}) {
  const items = [];
  const list = Array.isArray(hunks) ? hunks : [];
  let prevEnd = 1; // 下一个尚未展示的旧行号（1 起）

  for (const h of list) {
    const gap = (h.oldStart || 0) - prevEnd;
    if (gap > 0) items.push({ type: 'gap', lines: gap });
    items.push({ type: 'hunk', hunk: h });
    // oldLines=0 是「纯插入」（新文件，或插入点处没有旧行）：
    // 它不消耗旧行，所以下一个未展示的旧行号仍是 oldStart + 1
    prevEnd = h.oldLines ? h.oldStart + h.oldLines : (h.oldStart || 0) + 1;
  }

  const tail = (Number(oldTotal) || 0) + 1 - prevEnd;
  if (tail > 0) items.push({ type: 'gap', lines: tail });
  return items;
}

/**
 * 统一视图的行 → 并排视图的两栏行。
 *
 * 规则：上下文行左右各一份（同一行号）；一段连续删除 + 紧接着的一段连续插入**按下标配对**
 * ——这是 git 自己的做法，也是唯一能在没有更多信息时保持两侧对齐的办法。
 * 条数不等时少的一侧补 null（渲染成空白行）。
 *
 * @param {Array} rows 统一视图的行
 * @returns {Array<{left:object|null, right:object|null}>}
 */
export function toSplitRows(rows) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  let i = 0;
  while (i < list.length) {
    const r = list[i];
    if (r.t === ' ') {
      out.push({ left: r, right: r });
      i++;
      continue;
    }
    let d = i;
    while (d < list.length && list[d].t === '-') d++;
    let a = d;
    while (a < list.length && list[a].t === '+') a++;
    const dels = list.slice(i, d);
    const adds = list.slice(d, a);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      out.push({ left: dels[k] || null, right: adds[k] || null });
    }
    // 理论上到不了这里（上面两轮 while 至少吃掉一行），留着防脏数据死循环
    i = a > i ? a : i + 1;
  }
  return out;
}

