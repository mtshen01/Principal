import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSegments, toSplitRows } from './changes-diff.logic.js';

const ctx = (oldNo, newNo, text) => ({ t: ' ', oldNo, newNo, text });
const del = (oldNo, text) => ({ t: '-', oldNo, newNo: null, text });
const add = (newNo, text) => ({ t: '+', oldNo: null, newNo, text });

// ==================== diffSegments ====================

test('diffSegments：首中尾三段未展示的行都要出分隔条', () => {
  const file = {
    oldTotal: 100,
    hunks: [
      { oldStart: 11, oldLines: 5, newStart: 11, newLines: 6 },
      { oldStart: 51, oldLines: 4, newStart: 52, newLines: 4 },
    ],
  };
  const items = diffSegments(file);
  assert.deepEqual(
    items.map((x) => (x.type === 'gap' ? `gap:${x.lines}` : `hunk@${x.hunk.oldStart}`)),
    ['gap:10', 'hunk@11', 'gap:35', 'hunk@51', 'gap:46'],
  );
});

test('diffSegments：hunk 紧挨着时不出空分隔条', () => {
  const items = diffSegments({
    oldTotal: 10,
    hunks: [{ oldStart: 1, oldLines: 5 }, { oldStart: 6, oldLines: 5 }],
  });
  assert.deepEqual(items.map((x) => x.type), ['hunk', 'hunk']);
});

test('diffSegments：纯插入（oldLines=0）不消耗旧行，后继分隔条不会算错', () => {
  // 新文件：@@ -0,0 +1,2 @@
  assert.deepEqual(diffSegments({ oldTotal: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }] })
    .map((x) => x.type), ['hunk']);
  // 在第 3 行之后插入 → git 写作 @@ -3,0 +4,1 @@（零行一侧的起始号是「插入点前一行」）
  // 于是未展示的是前 2 行与第 4..10 行，共 7 行
  const items = diffSegments({
    oldTotal: 10,
    hunks: [{ oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 }],
  });
  assert.deepEqual(items.map((x) => (x.type === 'gap' ? `gap:${x.lines}` : 'hunk')), ['gap:2', 'hunk', 'gap:7']);
});

test('diffSegments：没有 hunk 或参数缺失时不崩', () => {
  assert.deepEqual(diffSegments({ hunks: [], oldTotal: 3 }), [{ type: 'gap', lines: 3 }]);
  assert.deepEqual(diffSegments(), [{ type: 'gap', lines: 0 }].filter((x) => x.lines > 0));
  assert.deepEqual(diffSegments({ hunks: [] }), []);
});

// ==================== toSplitRows ====================

test('toSplitRows：上下文行两侧共用同一行，行号一致', () => {
  const rows = toSplitRows([ctx(1, 1, 'a')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].left, rows[0].right);
  assert.equal(rows[0].left.oldNo, 1);
  assert.equal(rows[0].right.newNo, 1);
});

test('toSplitRows：删除与插入按下标配对', () => {
  const rows = toSplitRows([del(1, 'old1'), del(2, 'old2'), add(1, 'new1'), add(2, 'new2')]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.left.text, r.right.text]), [['old1', 'new1'], ['old2', 'new2']]);
  assert.equal(rows[0].left.oldNo, 1);
  assert.equal(rows[0].right.newNo, 1);
});

test('toSplitRows：条数不等时少的一侧补空行', () => {
  const delMore = toSplitRows([del(1, 'a'), del(2, 'b'), add(1, 'x')]);
  assert.deepEqual(delMore.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [['a', 'x'], ['b', null]]);
  const addMore = toSplitRows([del(1, 'a'), add(1, 'x'), add(2, 'y')]);
  assert.deepEqual(addMore.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [['a', 'x'], [null, 'y']]);
});

test('toSplitRows：纯插入与纯删除都不会丢行', () => {
  assert.deepEqual(
    toSplitRows([add(1, 'x'), add(2, 'y')]).map((r) => [r.left, r.right?.text]),
    [[null, 'x'], [null, 'y']],
  );
  assert.deepEqual(
    toSplitRows([del(1, 'x')]).map((r) => [r.left.text, r.right]),
    [['x', null]],
  );
});

test('toSplitRows：上下文夹在中间时顺序不乱', () => {
  const rows = toSplitRows([ctx(1, 1, 'a'), del(2, 'b'), add(2, 'B'), ctx(3, 3, 'c')]);
  assert.deepEqual(
    rows.map((r) => `${r.left ? r.left.text : '∅'}|${r.right ? r.right.text : '∅'}`),
    ['a|a', 'b|B', 'c|c'],
  );
});

test('toSplitRows：空输入返回空数组', () => {
  assert.deepEqual(toSplitRows([]), []);
  assert.deepEqual(toSplitRows(null), []);
});
