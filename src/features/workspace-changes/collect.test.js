/**
 * collect.js 的采集口径测试 —— 用**真 git 仓库**当夹具。
 *
 * 这一层要回答的问题（路径基准、已暂存算不算、未跟踪怎么进列表、子目录怎么截）
 * 全都在 git 自己的行为里，mock 掉 git 等于把被测对象换成自己的假设，测了个寂寞。
 * 所以这里建一个临时仓库、真跑几条 git，测完删掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectWorkspaceChanges, _clearWorkspaceChangesCache } from './collect.js';

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), `wc-repo-${process.pid}-`));
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), `wc-plain-${process.pid}-`));
const SUB = path.join(REPO, 'src');

function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(base, rel, text) {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test']);
git(['config', 'core.autocrlf', 'false']); // Windows 默认可能开着，会让「没改动」变成「整文件都改了」
write(REPO, 'src/a.js', 'const a = 1;\nconst b = 2;\n');
write(REPO, 'README.md', '# hello\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

// 每个用例都从「干净的一版」开始：不然上一个用例留下的改动会串到下一个
test.beforeEach(() => {
  git(['reset', '-q', '--hard', 'HEAD']);
  git(['clean', '-qfd']);
  _clearWorkspaceChangesCache();
});

test.after(() => {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(PLAIN, { recursive: true, force: true });
});

test('干净工作区 → empty + reason=no-changes（这不是错误）', async () => {
  const r = await collectWorkspaceChanges({ cwd: REPO });
  assert.equal(r.ok, true);
  assert.equal(r.empty, true);
  assert.equal(r.reason, 'no-changes');
  assert.deepEqual(r.summary, { files: 0, added: 0, removed: 0 });
  assert.deepEqual(r.files, []);
  assert.equal(r.tree.children.length, 0);
});

test('不是 git 仓库 → reason=not-a-repo（面板据此说人话，而不是报错）', async () => {
  const r = await collectWorkspaceChanges({ cwd: PLAIN });
  assert.equal(r.empty, true);
  assert.equal(r.reason, 'not-a-repo');
});

test('没有 cwd → 抛 badRequest（HTTP 层转 400）', async () => {
  await assert.rejects(() => collectWorkspaceChanges({ cwd: '' }), (e) => e.badRequest === true);
});

test('已跟踪改动：修改 / 删除 / 未跟踪，三类都在列表里且路径相对 cwd', async () => {
  write(REPO, 'src/a.js', 'const a = 1;\nconst b = 3;\nconst c = 4;\n'); // 改
  fs.rmSync(path.join(REPO, 'README.md')); // 删
  write(REPO, 'src/new.js', 'x\ny\n'); // 未跟踪

  const r = await collectWorkspaceChanges({ cwd: REPO });
  assert.equal(r.empty, false);
  assert.equal(r.summary.files, 3);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['README.md', 'src/a.js', 'src/new.js']);

  const mod = r.files.find((f) => f.path === 'src/a.js');
  assert.equal(mod.kind, 'modify');
  assert.equal(mod.added, 2);
  assert.equal(mod.removed, 1);
  assert.equal(mod.diffMode, 'unified');
  assert.equal(mod.hunks[0].rows.find((x) => x.t === '+').text, 'const b = 3;');

  const del = r.files.find((f) => f.path === 'README.md');
  assert.equal(del.kind, 'delete');
  assert.equal(del.deleted, true);
  assert.equal(del.removed, 1);

  const add = r.files.find((f) => f.path === 'src/new.js');
  assert.equal(add.kind, 'add');
  assert.equal(add.added, 2);
  assert.deepEqual(add.hunks[0].rows.map((x) => x.text), ['x', 'y']);

  // 树与列表同料
  const src = r.tree.children.find((c) => c.name === 'src');
  assert.equal(src.files, 2);
});

test('已暂存（git add 过）的改动同样算「未提交」', async () => {
  write(REPO, 'src/a.js', 'const a = 9;\nconst b = 2;\n');
  git(['add', 'src/a.js']);

  const r = await collectWorkspaceChanges({ cwd: REPO });
  const mod = r.files.find((f) => f.path === 'src/a.js');
  assert.ok(mod, '进了索引但没提交，仍是未提交改动');
  assert.equal(mod.added, 1);
  assert.equal(mod.removed, 1);
});

test('cwd 是仓库子目录时：只报本目录内的改动，路径相对该目录', async () => {
  write(REPO, 'src/a.js', 'const a = 1;\nconst b = 3;\n'); // 目录内
  write(REPO, 'README.md', '# changed\n'); // 目录外，不该出现

  const r = await collectWorkspaceChanges({ cwd: SUB });
  assert.deepEqual(r.files.map((f) => f.path), ['a.js'], '外面的改动不属于这个项目窗口');
});

test('未跟踪的二进制文件只报「变了」，不编造内容', async () => {
  fs.writeFileSync(path.join(REPO, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));

  const r = await collectWorkspaceChanges({ cwd: REPO });
  const bin = r.files.find((f) => f.path === 'blob.bin');
  assert.equal(bin.kind, 'add');
  assert.equal(bin.binary, true);
  assert.equal(bin.diffMode, 'none');
  assert.deepEqual(bin.hunks, []);
});

test('TTL 缓存：短时间内重复采集复用同一份结果（面板与徽标会同时轮询）', async () => {
  write(REPO, 'src/a.js', 'const a = 1;\nconst b = 7;\n');
  const first = await collectWorkspaceChanges({ cwd: REPO });
  const again = await collectWorkspaceChanges({ cwd: REPO });
  assert.equal(again, first);

  // 清掉缓存后必须看到最新的盘上状态（缓存不该把改动藏起来）
  _clearWorkspaceChangesCache();
  write(REPO, 'src/a.js', 'const a = 1;\nconst b = 8;\n');
  const after = await collectWorkspaceChanges({ cwd: REPO });
  assert.notEqual(after, first);
  assert.equal(after.files[0].hunks[0].rows.find((x) => x.t === '+').text, 'const b = 8;');
});
