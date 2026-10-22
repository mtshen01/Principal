/**
 * 「本次会话改动内容地图」的布局算法（纯函数，带单测）。
 *
 * 输入是后端 buildChangeTree 产出的目录树，输出是 map-canvas 直接能吃的 nodes/edges。
 * 布局是**分层整齐树**（tidy tree）：
 *   1. 深度决定列（x），同一个目录层级共用一列；
 *   2. 叶子按 DFS 顺序依次占行（y），行距固定 → 叶子之间永不重叠；
 *   3. 目录节点落在**子节点行的重心**上，视觉上「包住」自己那棵子树；
 *   4. 同一列内再按 y 排序强制拉开最小间距 —— 重心法会让同列的目录节点挤在一起
 *      （子树小的目录彼此靠得很近），不补这一步地图上会出现叠在一起的卡片。
 *
 * 为什么不用 req-map-layout.logic 的 layoutMap：那个是给「需求地图」的页面/逻辑点两层
 * 结构算的，节点高度按逻辑点条数变化；改动树的形状和约束都不同（深度不定、叶子数量不定），
 * 硬套会让它内部一堆为需求地图调过的常量变成误导。
 */

const DEFAULTS = { nodeW: 180, nodeH: 54, gapX: 64, gapY: 12 };

/** 根节点的占位 id：树的根 path 是空串，而空串当 DOM dataset/边端点会一路踩坑（falsy 判定） */
export const ROOT_ID = '.';

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function churnOf(n) {
  return (n?.added || 0) + (n?.removed || 0);
}

/**
 * @param {{type:'dir'|'file', path:string, name:string, added:number, removed:number,
 *          files:number, edits:number, children?:Array}} tree buildChangeTree 的根节点
 * @param {{nodeW?:number, nodeH?:number, gapX?:number, gapY?:number}} [opts]
 * @returns {{nodes:Array, edges:Array<{from:string,to:string}>, width:number, height:number}}
 */
export function layoutChangeMap(tree, opts = {}) {
  const nodeW = num(opts.nodeW, DEFAULTS.nodeW);
  const nodeH = num(opts.nodeH, DEFAULTS.nodeH);
  const gapX = num(opts.gapX, DEFAULTS.gapX);
  const gapY = num(opts.gapY, DEFAULTS.gapY);

  if (!tree || typeof tree !== 'object') {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const items = []; // { id, depth, row, data }
  const edges = [];
  let leafRow = 0;

  /** 先递归子树（拿到子节点的 row），再定自己的 row；返回本节点的 row 供父节点求重心 */
  function walk(node, depth, parentId) {
    const id = depth === 0 ? ROOT_ID : String(node.path ?? '');
    if (parentId !== null) edges.push({ from: parentId, to: id });

    const children = Array.isArray(node.children) ? node.children : [];
    let row;
    if (node.type === 'file' || children.length === 0) {
      row = leafRow++;
    } else {
      let sum = 0;
      for (const child of children) sum += walk(child, depth + 1, id);
      row = sum / children.length;
    }
    items.push({ id, depth, row, data: node });
    return row;
  }
  walk(tree, 0, null);

  // 同一列内拉开最小间距（1 行 = nodeH + gapY）
  const byDepth = new Map();
  for (const it of items) {
    if (!byDepth.has(it.depth)) byDepth.set(it.depth, []);
    byDepth.get(it.depth).push(it);
  }
  for (const list of byDepth.values()) {
    list.sort((a, b) => a.row - b.row || a.id.localeCompare(b.id));
    let prev = Number.NEGATIVE_INFINITY;
    for (const it of list) {
      if (it.row < prev + 1) it.row = prev + 1;
      prev = it.row;
    }
  }

  const maxDepth = items.reduce((m, it) => Math.max(m, it.depth), 0);
  // 归一化只取**文件**的最大改动量：目录的 churn 是子树之和，拿它当分母会让所有叶子都发白
  let maxLeafChurn = 0;
  for (const it of items) {
    if (it.data?.type === 'file') maxLeafChurn = Math.max(maxLeafChurn, churnOf(it.data));
  }
  const pitch = nodeH + gapY;

  const nodes = items.map((it) => ({
    id: it.id,
    x: it.depth * (nodeW + gapX),
    y: it.row * pitch,
    width: nodeW,
    height: nodeH,
    // heat 0~1：卡片底色深浅由它决定，「动得最多的地方」一眼可见
    heat: maxLeafChurn > 0 ? churnOf(it.data) / maxLeafChurn : 0,
    data: it.data,
  }));

  return {
    nodes,
    edges,
    width: (maxDepth + 1) * nodeW + maxDepth * gapX,
    height: Math.max(1, leafRow) * pitch,
  };
}
