import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitLines, countLines, buildUnifiedDiff, parseGitPatch, diffPath, pathFromDiffGit,
  newFileEntry, noDiffEntry,
  sortFileEntries, buildChangeTree, summarizeFiles, summarizeResult, wordSegments,
  applyRowBudget, hashText,
} from './changes.logic.js';

// ==================== 行工具 ====================

test('splitLines：末尾换行不产生空行', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines(null), []);
  assert.deepEqual(splitLines('a\n\nb\n'), ['a', '', 'b'], '中间的空行是真的空行');
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines(''), 0);
});

// ==================== 完整内容 → hunk（未跟踪文件那条路）====================

test('buildUnifiedDiff：出 git 式 hunk、行号、加减行数', () => {
  const d = buildUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.oldTotal, 3);
  assert.equal(d.newTotal, 3);
  assert.equal(d.hunks[0].header, '@@ -1,3 +1,3 @@');
  assert.deepEqual(
    d.hunks[0].rows.map((r) => [r.t, r.text, r.oldNo, r.newNo]),
    [[' ', 'a', 1, 1], ['-', 'b', 2, null], ['+', 'B', null, 2], [' ', 'c', 3, 3]],
  );
});

test('buildUnifiedDiff：同一对删除/插入会带行内词级分段', () => {
  const d = buildUnifiedDiff('const a = 1;\n', 'const a = 2;\n');
  const rows = d.hunks[0].rows.filter((r) => r.t !== ' ');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].segs && rows[1].segs, '词级分段该挂在删除行与插入行上');
  assert.equal(rows[0].segs.map((s) => s.text).join(''), 'const a = 1;');
  assert.equal(rows[1].segs.map((s) => s.text).join(''), 'const a = 2;');
  assert.ok(rows[1].segs.some((s) => s.em), '变了的那个字符要被标出来');
});

test('buildUnifiedDiff：内容过大 → null（宁可没有 diff，也不让响应炸掉）', () => {
  const big = 'x'.repeat(600 * 1024);
  assert.equal(buildUnifiedDiff(big, big + 'y'), null);
});

test('wordSegments：整行几乎全换时不做词级强调', () => {
  assert.equal(wordSegments('aaaa', 'bbbb'), null);
});

// ==================== git diff 输出 → hunk ====================

const MODIFY_PATCH = [
  'diff --git a/src/a.js b/src/a.js',
  'index 1111111..2222222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  '',
].join('\n');

test('parseGitPatch：修改——路径取 +++，行号来自 @@ 头', () => {
  const [f] = parseGitPatch(MODIFY_PATCH);
  assert.equal(f.path, 'src/a.js');
  assert.equal(f.kind, 'modify');
  assert.equal(f.deleted, false);
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.equal(f.diffMode, 'unified');
  assert.equal(f.hunks[0].header, '@@ -1,3 +1,4 @@');
  assert.deepEqual(
    f.hunks[0].rows.filter((r) => r.t !== ' ').map((r) => [r.t, r.text, r.oldNo, r.newNo]),
    [['-', 'const b = 2;', 2, null], ['+', 'const b = 3;', null, 2], ['+', 'const c = 4;', null, 3]],
  );
});

test('parseGitPatch：新增 / 删除（/dev/null 那一侧决定 kind）', () => {
  const [added] = parseGitPatch([
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    'index 0000000..e69de29',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,2 @@',
    '+x',
    '+y',
  ].join('\n'));
  assert.equal(added.kind, 'add');
  assert.equal(added.path, 'new.js');
  assert.equal(added.added, 2);
  assert.equal(added.removed, 0);

  const [gone] = parseGitPatch([
    'diff --git a/gone.js b/gone.js',
    'deleted file mode 100644',
    'index e69de29..0000000',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-x',
    '-y',
  ].join('\n'));
  assert.equal(gone.kind, 'delete');
  assert.equal(gone.path, 'gone.js', '删除的文件路径只能从 --- 那一侧拿');
  assert.equal(gone.deleted, true);
  assert.equal(gone.removed, 2);
});

test('parseGitPatch：重命名（纯改名没有任何 hunk，也要出条目）', () => {
  const [f] = parseGitPatch([
    'diff --git a/old.js b/new.js',
    'similarity index 100%',
    'rename from old.js',
    'rename to new.js',
  ].join('\n'));
  assert.equal(f.kind, 'rename');
  assert.equal(f.path, 'new.js');
  assert.equal(f.oldPath, 'old.js', '重命名要能看出从哪来');
  assert.equal(f.added + f.removed, 0);
  assert.deepEqual(f.hunks, []);
});

test('parseGitPatch：二进制与纯权限变更都不编造内容', () => {
  const [bin] = parseGitPatch([
    'diff --git a/img.png b/img.png',
    'index 1111111..2222222 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n'));
  assert.equal(bin.binary, true);
  assert.equal(bin.path, 'img.png');
  assert.deepEqual(bin.hunks, []);

  const [mode] = parseGitPatch([
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
  ].join('\n'));
  assert.equal(mode.modeOnly, true, '只有权限位变了也得算一条未提交改动');
  assert.equal(mode.binary, false);
});

test('parseGitPatch：转义过的路径解回原样（空格 / 制表符）', () => {
  const [f] = parseGitPatch([
    'diff --git "a/a\\tb.txt" "b/a\\tb.txt"',
    '--- "a/a\\tb.txt"',
    '+++ "b/a\\tb.txt"',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n'));
  assert.equal(f.path, 'a\tb.txt');
});

test('parseGitPatch：末尾无换行的标记行不占行号，挂到上一条上', () => {
  const [f] = parseGitPatch([
    'diff --git a/eof.js b/eof.js',
    '--- a/eof.js',
    '+++ b/eof.js',
    '@@ -1 +1 @@',
    '-x',
    '\\ No newline at end of file',
    '+y',
    '\\ No newline at end of file',
  ].join('\n'));
  const rows = f.hunks[0].rows;
  assert.equal(rows.length, 2, '标记行不是内容行');
  assert.equal(rows[0].noEol, true);
  assert.equal(rows[1].noEol, true);
});

test('parseGitPatch：多个文件块各自成条，空输出给空数组', () => {
  const both = parseGitPatch(MODIFY_PATCH + '\n' + [
    'diff --git a/b.js b/b.js',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1 @@',
    '-1',
    '+2',
  ].join('\n'));
  assert.deepEqual(both.map((f) => f.path), ['src/a.js', 'b.js']);
  assert.deepEqual(parseGitPatch(''), []);
  assert.deepEqual(parseGitPatch(null), []);
});

test('diffPath：剥 a/ b/ 前缀，/dev/null 给 null', () => {
  assert.equal(diffPath('a/x.js'), 'x.js');
  assert.equal(diffPath('b/src/x.js'), 'src/x.js');
  assert.equal(diffPath('/dev/null'), null);
  assert.equal(diffPath(''), null);
});

test('pathFromDiffGit：兜底解析 `diff --git` 行，切不干净时返回空串', () => {
  assert.equal(pathFromDiffGit('diff --git a/run.sh b/run.sh'), 'run.sh');
  assert.equal(pathFromDiffGit('diff --git a/my file.txt b/my file.txt'), 'my file.txt');
  assert.equal(pathFromDiffGit('diff --git a/x b/y b/x b/y'), '', '含 ` b/` 的路径切两刀都对不上 → 宁可空');
  assert.equal(pathFromDiffGit('diff --git a/old.js b/new.js'), '', '两侧不同（重命名）且无其它线索 → 不猜');
});

// ==================== 未跟踪文件 ====================

test('newFileEntry：整体都是新增，行号从 1 起', () => {
  const f = newFileEntry('untracked.txt', 'hello\nworld\n');
  assert.equal(f.kind, 'add');
  assert.equal(f.added, 2);
  assert.equal(f.removed, 0);
  assert.equal(f.diffMode, 'unified');
  assert.deepEqual(f.hunks[0].rows.map((r) => [r.t, r.newNo, r.text]), [
    ['+', 1, 'hello'], ['+', 2, 'world'],
  ]);
});

test('noDiffEntry：二进制 / 过大文件只报「变了」，不给内容', () => {
  const bin = noDiffEntry('a.bin', { binary: true });
  assert.equal(bin.binary, true);
  assert.equal(bin.diffMode, 'none');
  assert.deepEqual(bin.hunks, []);
  assert.equal(noDiffEntry('huge.txt', { tooLarge: true }).tooLarge, true);
  assert.equal(noDiffEntry('gone.js', { kind: 'delete' }).deleted, true);
});

// ==================== 聚合 ====================

test('sortFileEntries / summarizeFiles：改动量倒序 + 汇总', () => {
  const files = [
    { path: 'b.js', added: 1, removed: 0 },
    { path: 'a.js', added: 10, removed: 5 },
    { path: 'c.js', added: 1, removed: 0 },
  ];
  assert.deepEqual(sortFileEntries(files).map((f) => f.path), ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(summarizeFiles(files), { files: 3, added: 12, removed: 5 });
  assert.deepEqual(summarizeFiles([]), { files: 0, added: 0, removed: 0 });
});

test('buildChangeTree：目录汇总等于叶子之和，目录在前', () => {
  const tree = buildChangeTree([
    { path: 'src/store/a.js', added: 3, removed: 1, kind: 'modify', deleted: false },
    { path: 'src/b.js', added: 2, removed: 0, kind: 'add', deleted: false },
    { path: 'README.md', added: 0, removed: 4, kind: 'delete', deleted: true },
  ]);
  assert.equal(tree.files, 3);
  assert.equal(tree.added, 5);
  assert.equal(tree.removed, 5);
  assert.deepEqual(tree.children.map((c) => c.name), ['src', 'README.md'], '目录在前、文件在后');
  const src = tree.children[0];
  assert.equal(src.files, 2);
  assert.equal(src.added, 5);
  const store = src.children.find((c) => c.name === 'store');
  assert.equal(store.files, 1);
  assert.equal(store.children[0].path, 'src/store/a.js');
});

test('applyRowBudget：超预算的文件不再下发 hunk，但条目与计数都在', () => {
  const mk = (path, n) => ({
    path, added: n, removed: 0, diffMode: 'unified', truncated: false,
    hunks: [{ rows: Array.from({ length: n }, () => ({ t: '+' })) }],
  });
  const out = applyRowBudget([mk('a.js', 3), mk('b.js', 3), mk('c.js', 3)], 5);
  assert.equal(out.length, 3, '超预算的文件仍留在列表里');
  assert.equal(out[0].hunks.length, 1);
  assert.equal(out[0].truncated, false);
  assert.equal(out[1].hunks.length, 0);
  assert.equal(out[1].truncated, true);
  assert.equal(out[1].diffMode, 'none');
  assert.equal(out[1].added, 3, '计数仍是全量的');
  assert.equal(out[2].truncated, true);
});

test('hashText：内容变了指纹就变（哪怕增删行数一模一样）', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('+bar(x)'), hashText('+baz(x)'));
  assert.equal(typeof hashText(''), 'string');
});

test('summarizeResult：只带计数，不带文件与树（徽标轮询走它）', () => {
  const s = summarizeResult({ cwd: 'D:/p', empty: false, reason: '', summary: { files: 2, added: 3, removed: 4 } });
  assert.deepEqual(s, { ok: true, cwd: 'D:/p', empty: false, reason: '', summary: { files: 2, added: 3, removed: 4 } });
});
