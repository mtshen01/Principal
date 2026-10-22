/** src/entrypoints/web/routes-git.js
 * Git 相关 HTTP 端点 handler：status / branches / checkout
 */
import { execFile } from 'node:child_process';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';

/** 校验分支名：仅允许字母数字加 /.-_，禁止 .. 路径序列 */
const BRANCH_NAME_REGEX = /^(?!.*\.\.)[a-zA-Z0-9/_.-]+$/;

export function validateBranchName(name) {
  return typeof name === 'string' && BRANCH_NAME_REGEX.test(name);
}

/**
 * 执行 git 命令的通用工具函数
 * @param {string} cwd 工作目录
 * @param {string[]} args git 命令参数
 * @param {number} timeout 超时（毫秒）
 * @returns {Promise<{stdout: string, stderr: string, code: number|string}>}
 */
function execGit(cwd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout }, (err, stdout, stderr) => {
      resolve({
        // execFile 超时后 err.killed=true / err.signal='SIGTERM'，code 为 null
        code: (err?.killed || !!err?.signal) ? 'TIMEOUT' : (err ? 1 : 0),
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

/** GET /api/git/status - 检查是否 git 仓库，返回当前分支 */
export async function handleGitStatus(cwd, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, 200, { isGit: false, cwd: '' });
  }

  const isGitCheck = await execGit(cwdStr, ['rev-parse', '--is-inside-work-tree']);
  const isGit = isGitCheck.stdout === 'true';

  if (!isGit) {
    return sendJson(res, 200, { isGit: false, cwd: cwdStr });
  }

  const branchCheck = await execGit(cwdStr, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = branchCheck.code === 0 ? branchCheck.stdout : 'HEAD';

  sendJson(res, 200, { isGit: true, currentBranch, cwd: cwdStr });
}

/**
 * 解析 git branch -a --format=... 的输出行，返回 { local, remote, current }。
 * 纯函数，便于单元测试。
 *
 * 用 ref 全名（`refs/heads/x` / `refs/remotes/origin/x`）而非 `refname:short` 分类：
 * short 形式下远程分支就叫 `origin/x`，无从与同名本地分支区分，且 `origin/HEAD`
 * 会缩成一个看着像分支的 `origin`。
 *
 * @param {string[]} lines 每行格式：`<refname 全名>|(SEP)|<true|false>`
 * @returns {{ local: string[], remote: string[], current: string }}
 */
export function parseBranchLines(lines) {
  const local = [];
  const remote = [];
  let current = '';

  for (const line of lines) {
    const [ref, isCurrent] = line.split('|(SEP)|');
    if (!ref) continue;

    let name = '';
    if (ref.startsWith('refs/heads/')) {
      name = ref.slice('refs/heads/'.length);
      local.push(name);
    } else if (ref.startsWith('refs/remotes/')) {
      name = ref.slice('refs/remotes/'.length);
      if (name.endsWith('/HEAD')) continue; // origin/HEAD 是符号引用，不是分支
      remote.push(name);
    } else {
      continue;
    }

    if (isCurrent === 'true') current = name;
  }

  local.sort();
  remote.sort();

  return { local, remote, current };
}

/** GET /api/git/branches - 列出本地和远程分支，可选 refresh=1 触发 fetch */
export async function handleGitBranches(cwd, refresh, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, 400, { error: '缺少工作目录' });
  }

  if (refresh === '1') {
    const fetchResult = await execGit(cwdStr, ['fetch', '--all'], 10000);
    if (fetchResult.code === 'TIMEOUT') {
      return sendJson(res, 500, { error: 'git fetch 超时（10s）' });
    }
    if (fetchResult.code !== 0) {
      return sendJson(res, 500, { error: fetchResult.stderr || 'git fetch 失败' });
    }
  }

  // 列出所有分支（--format 含 HEAD 标记）
  const branchResult = await execGit(cwdStr, [
    'branch', '-a',
    '--format=%(refname)|(SEP)|%(if)%(HEAD)%(then)true%(else)false%(end)',
  ]);

  if (branchResult.code !== 0) {
    return sendJson(res, 500, { error: branchResult.stderr || 'git branch 失败' });
  }

  const lines = branchResult.stdout.split('\n').filter((l) => l.trim());
  const { local, remote, current } = parseBranchLines(lines);

  sendJson(res, 200, { local, remote, current });
}

/** POST /api/git/checkout - 切换分支 */
export async function handleGitCheckout(cwd, req, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, 400, { error: '缺少工作目录' });
  }

  // 签名是 withJsonBody(req, res, fn)：漏掉 res 会让回调被当成 res、fn 变 undefined，
  // 于是 `await fn()` 抛 TypeError → catch 里又拿函数当 res 写头二次抛错 → 本请求永不响应。
  return withJsonBody(req, res, async (body) => {
    const branch = str(body?.branch);
    if (!branch || !validateBranchName(branch)) {
      return sendJson(res, 400, { error: '无效的分支名' });
    }

    const checkoutResult = await execGit(cwdStr, ['checkout', branch], 5000);

    if (checkoutResult.code === 'TIMEOUT') {
      return sendJson(res, 500, { error: 'git checkout 超时（5s）' });
    }

    if (checkoutResult.code === 0) {
      return sendJson(res, 200, { ok: true, branch });
    }

    sendJson(res, 500, { error: checkoutResult.stderr || 'git checkout 失败' });
  });
}

/**
 * 把 `git branch -a` 风格的远程全名（`origin/feat/x`）拆成 { remote, branch }。
 * 纯函数，便于单元测试。
 *
 * 不能简单按第一个 `/` 切：remote 名本身允许含 `/`（虽不常见），那样会把 remote 名截错。
 * 因此按**已配置的 remote 名**做最长前缀匹配，认不出来才退化成首段（保证仍能给出可读报错）。
 *
 * @param {string} fullRef 形如 `origin/feat/x`
 * @param {string[]} remoteNames `git remote` 的输出
 * @returns {{ remote: string, branch: string }|null} 无法拆分时返回 null
 */
export function splitRemoteRef(fullRef, remoteNames = []) {
  if (typeof fullRef !== 'string' || !fullRef.includes('/')) return null;
  const names = Array.isArray(remoteNames) ? remoteNames : [];
  let remote = '';
  for (const n of names) {
    if (typeof n === 'string' && n && fullRef.startsWith(n + '/') && n.length > remote.length) {
      remote = n;
    }
  }
  if (!remote) remote = fullRef.slice(0, fullRef.indexOf('/'));
  const branch = fullRef.slice(remote.length + 1);
  if (!remote || !branch) return null;
  return { remote, branch };
}

/**
 * POST /api/git/delete-branch - 删除分支
 *
 * 本地分支：先 `git branch -d`（未合并会被 git 拒绝），失败时回 `{ok:false, needForce:true}`，
 * 由前端二次确认后带 force=1 走 `git branch -D`。当前所在分支直接拒绝（git 本来也删不掉，
 * 这里提前拦是为了给出中文提示、并避免把「当前分支」误判成 needForce）。
 *
 * 远程分支：`git push <remote> --delete <branch>`（远端不可恢复，前端确认文案更重）。
 */
export async function handleGitDeleteBranch(cwd, req, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, 400, { error: '缺少工作目录' });
  }

  return withJsonBody(req, res, async (body) => {
    const isRemote = body?.type === 'remote';
    const force = body?.force === true;
    const raw = str(body?.branch);
    if (!raw) {
      return sendJson(res, 400, { error: '无效的分支名' });
    }

    if (isRemote) {
      const remoteList = await execGit(cwdStr, ['remote']);
      const remotes = remoteList.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const parsed = splitRemoteRef(raw, remotes);
      if (!parsed || !validateBranchName(parsed.remote) || !validateBranchName(parsed.branch)) {
        return sendJson(res, 400, { error: '无效的分支名' });
      }
      const pushResult = await execGit(
        cwdStr,
        ['push', parsed.remote, '--delete', parsed.branch],
        15000,
      );
      if (pushResult.code === 'TIMEOUT') {
        return sendJson(res, 500, { error: 'git push 删除远程分支超时（15s）' });
      }
      if (pushResult.code !== 0) {
        return sendJson(res, 500, { error: pushResult.stderr || '删除远程分支失败' });
      }
      return sendJson(res, 200, { ok: true, branch: raw });
    }

    if (!validateBranchName(raw)) {
      return sendJson(res, 400, { error: '无效的分支名' });
    }

    const headResult = await execGit(cwdStr, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (headResult.code === 0 && headResult.stdout === raw) {
      return sendJson(res, 200, { ok: false, error: '不能删除当前所在分支，请先切换到其它分支' });
    }

    // 分支不存在时直接报错，不要给出 needForce —— 否则前端会为一条不存在的分支多弹一次确认
    const existsResult = await execGit(cwdStr, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + raw]);
    if (existsResult.code !== 0) {
      return sendJson(res, 200, { ok: false, error: '分支不存在或已被删除' });
    }

    const delResult = await execGit(cwdStr, ['branch', force ? '-D' : '-d', raw], 5000);
    if (delResult.code === 'TIMEOUT') {
      return sendJson(res, 500, { error: 'git branch 删除超时（5s）' });
    }
    if (delResult.code === 0) {
      return sendJson(res, 200, { ok: true, branch: raw });
    }

    // -d 失败绝大多数是「未合并」。让前端二次确认走 -D；其它原因（如分支被别的 worktree 占用）
    // 会在 force 那再失败一次并如实报出，不会被静默吞掉。
    sendJson(res, 200, {
      ok: false,
      branch: raw,
      needForce: !force,
      error: delResult.stderr || delResult.stdout || 'git branch 删除失败',
    });
  });
}
