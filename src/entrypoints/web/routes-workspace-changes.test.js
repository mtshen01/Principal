/**
 * /api/workspace-changes 的接口边界测试。
 *
 * 夹具是一个**临时 git 仓库**：这一层的输入只有 cwd 一个，而它的全部语义都落在 git 上，
 * 用手写数据 mock 掉 git 就测不到「已暂存算不算」「未跟踪进不进列表」这类真问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { handleWorkspaceChanges } from './routes-workspace-changes.js';
import { _clearWorkspaceChangesCache } from '../../features/workspace-changes/collect.js';

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), `wc-routes-${process.pid}-`));
const PLAIN = fs.mkdtempSync(path.join(os.tmpdir(), `wc-routes-plain-${process.pid}-`));

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test']);
git(['config', 'core.autocrlf', 'false']);
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'a.js'), 'x\ny\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

let server;
let base;
test.before(async () => {
  server = createServer((req, res) => handleWorkspaceChanges(new URL(req.url, 'http://x'), res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(PLAIN, { recursive: true, force: true });
});

async function get(query) {
  const res = await fetch(`${base}/api/workspace-changes?${query}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

test('缺 cwd → 400（没有项目目录就没有「未提交」可言）', async () => {
  const r = await get('');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cwd/);
});

test('目录不是 git 仓库 → 200 + reason=not-a-repo（是正常状态，不是故障）', async () => {
  const r = await get('cwd=' + encodeURIComponent(PLAIN));
  assert.equal(r.status, 200);
  assert.equal(r.json.empty, true);
  assert.equal(r.json.reason, 'not-a-repo');
});

test('完整视图返回列表 + 内容地图树 + hunks', async () => {
  _clearWorkspaceChangesCache();
  fs.writeFileSync(path.join(REPO, 'src', 'a.js'), 'x\nY\nz\n');

  const r = await get('cwd=' + encodeURIComponent(REPO));
  assert.equal(r.status, 200);
  assert.equal(r.json.summary.files, 1);
  assert.equal(r.json.summary.added, 2);
  assert.equal(r.json.summary.removed, 1);
  assert.equal(r.json.files[0].path, 'src/a.js');
  assert.equal(r.json.files[0].kind, 'modify');
  assert.equal(r.json.files[0].diffMode, 'unified');
  assert.equal(r.json.files[0].hunks[0].header, '@@ -1,2 +1,3 @@');
  assert.deepEqual(
    r.json.files[0].hunks[0].rows.filter((x) => x.t !== ' ').map((x) => [x.t, x.text]),
    [['-', 'y'], ['+', 'Y'], ['+', 'z']],
  );
  assert.equal(r.json.tree.children[0].name, 'src');
  assert.equal(r.json.tree.children[0].files, 1);
});

test('view=summary 只回计数，不带 files / tree（徽标轮询走这条，省带宽）', async () => {
  _clearWorkspaceChangesCache();
  const r = await get(`cwd=${encodeURIComponent(REPO)}&view=summary`);
  assert.equal(r.status, 200);
  assert.equal(r.json.summary.files, 1);
  assert.equal(r.json.files, undefined);
  assert.equal(r.json.tree, undefined);
});
