import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutChangeMap, ROOT_ID } from './changes-map.logic.js';

function file(name, path, added, removed) {
  return { type: 'file', name, path, added, removed, edits: 1, files: 1 };
}
function dir(name, path, children) {
  return { type: 'dir', name, path, children, added: 0, removed: 0, edits: 0, files: 0 };
}

/** 树：src/{store/{a.js,b.js}, index.js} */
function sampleTree() {
  return dir('', '', [
    dir('src', 'src', [
      dir('store', 'src/store', [
        file('b.js', 'src/store/b.js', 10, 0),
        file('a.js', 'src/store/a.js', 2, 2),
      ]),
      file('index.js', 'src/index.js', 1, 1),
    ]),
  ]);
}

test('空树返回空布局', () => {
  const r = layoutChangeMap(null);
  assert.deepEqual(r.nodes, []);
  assert.deepEqual(r.edges, []);
  const r2 = layoutChangeMap({ type: 'dir', path: '', children: [] });
  assert.equal(r2.nodes.length, 1);
  assert.equal(r2.nodes[0].id, ROOT_ID, '根节点用占位 id，不能用空串');
});

test('深度决定列：x 按层级递增，同一层 x 相同', () => {
  const { nodes } = layoutChangeMap(sampleTree(), { nodeW: 100, gapX: 50 });
  const at = (id) => nodes.find((n) => n.id === id);
  assert.equal(at(ROOT_ID).x, 0);
  assert.equal(at('src').x, 150);
  assert.equal(at('src/store').x, 300);
  assert.equal(at('src/index.js').x, 300, '同深度共用一列');
});

test('叶子按 DFS 顺序逐行排，行距固定 → 不重叠', () => {
  const { nodes } = layoutChangeMap(sampleTree(), { nodeH: 50, gapY: 10 });
  const ys = ['src/store/b.js', 'src/store/a.js', 'src/index.js'].map(
    (id) => nodes.find((n) => n.id === id).y,
  );
  assert.deepEqual(ys, [0, 60, 120], '叶子依次占 0/1/2 行，行距 = 高度 + 间隙');
});

test('目录节点落在子节点行的重心', () => {
  const { nodes } = layoutChangeMap(sampleTree(), { nodeH: 50, gapY: 10 });
  const at = (id) => nodes.find((n) => n.id === id);
  // store 的两个子节点在 0 行与 1 行 → 重心 0.5 行 = 30px
  assert.equal(at('src/store').y, 30);
  // src 的三个子节点（store 重心 0.5、index 在第 2 行）→ 重心 (0.5+2)/2？不对：
  // src 的子节点是 store（重心 0.5）与 index.js（2）→ (0.5+2)/2 = 1.25 行 = 75px
  assert.equal(at('src').y, 75);
});

test('同一列的目录节点被拉开最小间距（重心法会撞在一起）', () => {
  // two/ 与 three/ 都是单叶子子树，重心都落在自己唯一叶子的行上；
  // 若不补同列去重，它们的 y 会与别的同列节点挤在一处
  const tree = dir('', '', [
    dir('one', 'one', [file('a.js', 'one/a.js', 5, 0)]),
    dir('two', 'two', [file('b.js', 'two/b.js', 5, 0), file('c.js', 'two/c.js', 5, 0)]),
    dir('three', 'three', [file('d.js', 'three/d.js', 5, 0)]),
  ]);
  const { nodes } = layoutChangeMap(tree, { nodeH: 50, gapY: 10 });
  const col1 = nodes.filter((n) => n.x === 244 || n.x === nodes.find((m) => m.id === 'one').x);
  assert.equal(col1.length, 3);
  const ys = col1.map((n) => n.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] - ys[i - 1] >= 60 - 1e-9, `同列节点间距不足：${JSON.stringify(ys)}`);
  }
});

test('heat 按文件最大改动量归一，目录不吃分母', () => {
  const { nodes } = layoutChangeMap(sampleTree());
  const at = (id) => nodes.find((n) => n.id === id);
  assert.equal(at('src/store/b.js').heat, 1, '改动最多的文件是满热');
  assert.equal(at('src/store/a.js').heat, 4 / 10);
  assert.equal(at('src/index.js').heat, 2 / 10);
  // 目录 churn（store = 14）比最大文件（10）大，若拿全局最大值当分母，叶子全都发白
  assert.ok(at('src/store').heat <= 1);
});

test('节点数与边数对得上：每个非根节点恰好一条父边', () => {
  const { nodes, edges } = layoutChangeMap(sampleTree());
  assert.equal(edges.length, nodes.length - 1);
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), `悬空边 ${JSON.stringify(e)}`);
  }
});

test('宽高覆盖全部节点（画布包围盒不能裁掉卡片）', () => {
  const { nodes, width, height } = layoutChangeMap(sampleTree());
  for (const n of nodes) {
    assert.ok(n.x + n.width <= width);
    assert.ok(n.y + n.height <= height);
  }
});
