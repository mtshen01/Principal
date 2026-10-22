/**
 * 未提交改动的 IO 层：**只跑 git**，把结果交给 changes.logic 组装。
 *
 * 三次子进程拿到全部素材：
 *   1. `rev-parse --is-inside-work-tree`  —— 先确认这是个仓库，否则「不是 git 仓库」是个正常答案
 *   2. `diff <HEAD> --relative`           —— 已跟踪文件的未提交改动（已暂存 + 未暂存一次拿全）
 *   3. `ls-files --others`                —— 未跟踪文件（不在 diff 里，得单独列）
 *
 * 为什么一次 `git diff` 而不是「每文件一条 git show HEAD:path」：Windows 上起一个 git 进程
 * 约几十毫秒，几十个改动文件就是秒级延迟，而这个接口被面板 5s 一轮询着。git 自己算好的补丁
 * 里已经有精确的行号与上下文，解析它（parseGitPatch）比自算便宜得多。
 *
 * 缓存按 cwd 命中，TTL 很短：工作区随时在变，长缓存等于骗人；它只用来吸收
 * 「面板轮询与顶栏徽标轮询撞在同一秒」这种重复劳动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from '../../integrations/shell.js';
import {
  parseGitPatch, newFileEntry, noDiffEntry, sortFileEntries, buildChangeTree, summarizeFiles,
  applyRowBudget, hashText, MAX_TEXT_BYTES, MAX_FILES, CONTEXT_LINES,
} from './changes.logic.js';

/** 单条 git 命令的超时：只读操作，卡住就是仓库有问题（巨大仓库 / 网络盘），不该拖住一个 HTTP 请求 */
const GIT_TIMEOUT_MS = 15_000;

/** 未跟踪文件最多读多少个：`node_modules` 没进 .gitignore 的仓库能列出几万个 */
const MAX_UNTRACKED = 200;

/** 结果缓存的有效期（毫秒），见文件头 */
const CACHE_TTL_MS = 1500;

/** 只保留最近几个 cwd 的结果（多窗口 / 切项目时别让 map 一直涨） */
const CACHE_MAX = 6;

/** 空树对象名：仓库还没有任何提交时拿它当 diff 基线（等价于「所有东西都是新增的」） */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** cwd → { at, result } */
const cache = new Map();
/** cwd → Promise：同一目录的并发请求共用在途的那一次，不重复起 git */
const inflight = new Map();

/** 全部参数都是常量（无用户输入拼接），路径只经 cwd 传参 —— 与 routes-git 同一套纪律 */
function git(cwd, args) {
  return runScript('git', args, { cwd, shell: false, timeoutMs: GIT_TIMEOUT_MS });
}

/**
 * 采集一次「未提交改动」。
 *
 * @param {{cwd:string}} opts 项目目录（绝对路径；相对路径会按服务进程的 cwd 解析）
 * @returns {Promise<object>} 结果形状见 emptyResult；**「不是仓库 / 没有改动」都是一种正常结果**
 * @throws {Error & {badRequest?:boolean}} cwd 缺失时抛 badRequest（HTTP 层转 400）
 */
export async function collectWorkspaceChanges({ cwd = '' } = {}) {
  const dir = String(cwd || '').trim();
  if (!dir) throw Object.assign(new Error('缺少 cwd'), { badRequest: true });

  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const running = inflight.get(dir);
  if (running) return running;

  const task = doCollect(dir)
    .then((result) => {
      cache.set(dir, { at: Date.now(), result });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return result;
    })
    .finally(() => inflight.delete(dir));
  inflight.set(dir, task);
  return task;
}

async function doCollect(dir) {
  const probe = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  // 连 git 都没起来（PATH 里没有 / cwd 不存在）：这是服务端问题，不该说成「不是仓库」
  if (probe.msg) throw new Error(probe.msg);
  if (!probe.ok || (probe.out || '').trim() !== 'true') return emptyResult(dir, 'not-a-repo');

  // 仓库还没有任何提交时 HEAD 不存在 —— 用空树当基线，语义仍是「所有东西都未提交」
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  const base = head.ok ? 'HEAD' : EMPTY_TREE;

  const [diff, others] = await Promise.all([
    git(dir, [
      '-c', 'core.quotePath=false',
      'diff', base,
      '--relative', // 只报 cwd 之内的改动，且路径相对 cwd（一窗一项目）
      '--no-color', '--no-ext-diff', '--no-textconv',
      `--unified=${CONTEXT_LINES}`,
    ]),
    git(dir, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (!diff.ok) throw new Error(`git diff 失败：${(diff.err || diff.out || '').slice(0, 200) || '未知原因'}`);

  const tracked = parseGitPatch(diff.out || '');
  const untrackedPaths = (others.ok ? others.out || '' : '').split('\0').filter(Boolean);
  const untracked = readUntracked(dir, untrackedPaths);

  const all = sortFileEntries([...tracked, ...untracked.entries]);
  const files = applyRowBudget(all.slice(0, MAX_FILES));
  return {
    ok: true,
    cwd: dir,
    empty: files.length === 0,
    reason: files.length ? '' : 'no-changes',
    // 内容指纹：前端靠它判断「要不要重画」。只比增删行数会漏掉「改完还是 +1 -1」的第二次编辑
    rev: hashText(diff.out || ''),
    truncated: {
      files: all.length > files.length,
      // 未跟踪文件被列的上限截断（`ls-files` 自己不会截断，截断发生在这里）
      untracked: untrackedPaths.length > MAX_UNTRACKED,
    },
    summary: summarizeFiles(files),
    files,
    tree: buildChangeTree(files),
  };
}

/**
 * 读未跟踪文件的盘上内容 → 新增条目。
 * 读不动（并发被删 / 权限）就当它不存在：一次采集失败不该让整个面板报错。
 */
function readUntracked(dir, relPaths) {
  const entries = [];
  const list = relPaths.slice(0, MAX_UNTRACKED);
  for (const rel of list) {
    if (!rel) continue;
    const abs = path.join(dir, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
      if (!stat.isFile()) continue; // 符号链接目标不是文件 / 目录残影
    } catch {
      continue;
    }
    if (stat.size > MAX_TEXT_BYTES) {
      entries.push(noDiffEntry(rel, { kind: 'add', tooLarge: true }));
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // NUL 字节 = 二进制。对二进制做文本 diff 只会产出成片的乱码行
    entries.push(text.includes('\0') ? noDiffEntry(rel, { kind: 'add', binary: true }) : newFileEntry(rel, text));
  }
  return { entries };
}

function emptyResult(cwd, reason) {
  return {
    ok: true,
    cwd: cwd || '',
    empty: true,
    reason,
    rev: '0',
    truncated: { files: false, untracked: false },
    summary: { files: 0, added: 0, removed: 0 },
    files: [],
    tree: { type: 'dir', name: '', path: '', added: 0, removed: 0, files: 0, children: [] },
  };
}

/** 单测用：清空结果缓存与在途表，避免用例之间互相污染 */
export function _clearWorkspaceChangesCache() {
  cache.clear();
  inflight.clear();
}
