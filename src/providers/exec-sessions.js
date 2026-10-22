/**
 * 命令会话管理器（P1-6）运行时 —— Codex `unified_exec` 的对位：
 * `exec_command` 启动进程并最多等一个 yield 时间片（默认 10s），未结束返回进程号；
 * `write_stdin` 继续轮询/写入；`list_processes` / `kill_process` 管理。
 *
 * 口径见 `docs/superpowers/specs/2026-10-11-exec-sessions-design.md`：
 * - 会话表 **per-run**（每个 run 一份 createExecSessions，不跨 run 泄漏）；
 * - run 结束（正常/失败/停止）一律 `terminateAll()`（接线在 run-openai 的 finally 与 abort 信号）；
 * - 输出缓冲/读取上限/文案在 exec-sessions.logic.js（纯函数）；本模块只管 spawn 与登记表；
 * - 执行后端复用 T6 的 `makeBashSpawn`（local/container/unavailable，fail-closed 不静默回本地）；
 * - 杀进程树复用共享 `killTree`（与 Bash 工具同一实现：Windows taskkill /T，其余 SIGKILL）。
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { resolveWorkspace } from '../shared/workspace-paths.js';
import { makeBashSpawn } from './exec-backends.logic.js';
import { killTree } from './exec-backends.js';
import {
  SESSIONS,
  createBuffer,
  bufferAppend,
  bufferDrain,
  clampYieldMs,
  listStatusText,
  formatUnknown,
  formatBackendUnavailable,
  formatAtCapacity,
  formatRunAborted,
  formatExecStart,
  formatWriteResult,
  formatKillResult,
  formatList,
} from './exec-sessions.logic.js';

/** 会话族工具名（run-openai 的 disabled 展开与快捷判断共用同一份） */
export const EXEC_SESSION_TOOL_NAMES = Object.freeze(['exec_command', 'write_stdin', 'list_processes', 'kill_process']);

/** system 提示词片段（实现在 logic 层；入口经本模块取，不必知道模块分层） */
export { buildExecSessionsPrompt } from './exec-sessions.logic.js';

/** 工具定义：名字/入参对齐 Codex（snake_case）——模型训练语料里对这套形态最熟 */
const TOOL_DEFS = Object.freeze({
  exec_command: {
    description:
      '启动一条 shell 命令并最多等待 yield_ms（默认 10000 毫秒，范围 250–30000）。若在等待内结束：直接返回输出与退出码；' +
      '仍在运行：返回进程号（process_id），之后用 write_stdin 轮询输出/写入输入、kill_process 结束。' +
      '适合长任务（dev server、大构建、全量测试）与需要 stdin 交互的命令；很快返回的普通命令直接用 Bash。',
    inputSchema: z.object({
      command: z.string().describe('要执行的命令（在工作目录下运行）'),
      yield_ms: z.coerce.number().int().optional().describe('本次等待的毫秒数（默认 10000，范围 250–30000）'),
    }),
  },
  write_stdin: {
    description:
      '读取某个后台进程的新输出（单次最多 8KB，读走即清；进程已退出时仍可读到收尾输出），可选写入 stdin。' +
      '没有新输出时会等待最多 yield_ms（默认 5000 毫秒）再返回。',
    inputSchema: z.object({
      process_id: z.coerce.number().int().positive().describe('exec_command 返回的进程号'),
      chars: z.string().optional().describe('要写入进程 stdin 的内容（可选；不写则只轮询输出）'),
      yield_ms: z.coerce.number().int().optional().describe('本次等待的毫秒数（默认 5000，范围 250–30000）'),
    }),
  },
  list_processes: {
    description: '列出本任务启动过的后台命令：进程号、状态（运行中/已退出/已终止）、运行时长、未读输出量。',
    inputSchema: z.object({}),
  },
  kill_process: {
    description: '终止一个后台命令（连带其子进程树）；结束后仍可读到收尾输出。',
    inputSchema: z.object({
      process_id: z.coerce.number().int().positive().describe('exec_command 返回的进程号'),
    }),
  },
});

const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
};

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.(); // 等待不该拖住进程退出（测试/服务收尾）
  });
}

function toId(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 造一套绑定到某个 run 的命令会话工具。
 * @param {{ cwd?: string, signal?: AbortSignal, bashBackend?: object }} [opts]
 *   signal 传 run 的 abortController.signal：用户点「停止」→ 全部会话秒杀；
 *   bashBackend 同 Bash 工具（exec-backends.js#resolveBashBackend 的产物）。
 * @returns {{ toolDefs: object, executeTool: (name:string, input:any)=>Promise<string>,
 *             terminateAll: () => void, list: () => string, size: () => number,
 *             execCommand: Function, writeStdin: Function, killProcess: Function }}
 *   入口只消费 toolDefs/executeTool/terminateAll；execCommand 等内部方法暴露给单测直驱。
 */
export function createExecSessions({ cwd, signal, bashBackend = { kind: 'local' } } = {}) {
  const workspace = resolveWorkspace(cwd);
  const sessions = new Map(); // id -> rec
  let nextId = 0;
  // abort 触发一次 terminateAll（一次性 promise，避免每次工具调用都挂监听）
  const abortPromise = signal
    ? new Promise((resolve) => signal.addEventListener('abort', () => { terminateAll(); resolve(); }, { once: true }))
    : new Promise(() => {});

  /** 杀全部活动会话；幂等（run 收尾与 abort 可能先后各调一次） */
  function terminateAll() {
    for (const rec of sessions.values()) {
      if (rec.status !== 'running' || rec.terminating) continue;
      rec.terminating = true;
      rec.killRequested = true;
      killTree(rec.child);
    }
  }

  function finalize(rec, code) {
    if (rec.closeSettled) return;
    rec.closeSettled = true;
    clearTimeout(rec.exitTimer);
    // 多字节字符可能跨 chunk：收尾时 flush 两个 decoder 的残量
    bufferAppend(rec.buffer, rec.outDec.end() + rec.errDec.end());
    rec.status = rec.killRequested ? 'killed' : 'exited';
    if (typeof code === 'number') rec.code = code;
    rec.exitedAt = Date.now();
    rec.closeResolve();
  }

  function spawnSession(command) {
    const plan = makeBashSpawn(bashBackend, command, workspace);
    const child = spawn(plan.bin, plan.args, { shell: plan.shell, cwd: workspace, env: process.env, windowsHide: true });
    const rec = {
      id: ++nextId,
      command,
      child,
      status: 'running',
      code: null,
      startedAt: Date.now(),
      exitedAt: null,
      killRequested: false,
      terminating: false,
      closeSettled: false,
      exitTimer: null,
      buffer: createBuffer(),
      outDec: new StringDecoder('utf8'),
      errDec: new StringDecoder('utf8'),
      closeResolve: null,
    };
    rec.closed = new Promise((resolve) => {
      rec.closeResolve = resolve;
    });
    child.stdout?.on('data', (d) => bufferAppend(rec.buffer, rec.outDec.write(d)));
    child.stderr?.on('data', (d) => bufferAppend(rec.buffer, rec.errDec.write(d)));
    child.stdin?.on('error', () => {}); // EPIPE 等：写 stdin 失败不影响读输出
    child.on('error', (e) => {
      bufferAppend(rec.buffer, `\n[启动失败] ${e?.message || String(e)}\n`);
      finalize(rec, null);
    });
    child.on('close', (code) => finalize(rec, code));
    child.on('exit', (code) => {
      // 宽限：正常路径 close 紧跟 exit；孙进程持管道时 close 可能不来，宽限后按已退出结算
      rec.exitTimer = setTimeout(() => finalize(rec, code), SESSIONS.EXIT_GRACE_MS);
      rec.exitTimer.unref?.();
    });
    return rec;
  }

  /** 起一条后台命令；等待不超过 yieldMs（或进程先退出 / run 被停止） */
  async function execCommand({ command, yield_ms } = {}) {
    if (signal?.aborted) return formatRunAborted();
    if (bashBackend?.kind === 'unavailable') return formatBackendUnavailable(bashBackend.reason || '未知原因');
    const cmd = String(command ?? '').trim();
    if (!cmd) return '错误：command 不能为空';
    if (sessions.size >= SESSIONS.MAX_SESSIONS) {
      // 先回收已退出的最旧会话腾位；全在跑才拒绝（不静默杀活动进程）
      const evict = [...sessions.values()]
        .filter((r) => r.status !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!evict) return formatAtCapacity(SESSIONS.MAX_SESSIONS);
      sessions.delete(evict.id);
    }
    let rec;
    try {
      rec = spawnSession(cmd);
    } catch (e) {
      return `无法启动命令：${e?.message || String(e)}`;
    }
    sessions.set(rec.id, rec);
    const waitMs = clampYieldMs(yield_ms, SESSIONS.DEFAULT_YIELD_MS);
    await Promise.race([rec.closed, sleep(waitMs), abortPromise]);
    const abortedNow = !!signal?.aborted && rec.status === 'running';
    return formatExecStart({ rec, output: bufferDrain(rec.buffer).text, aborted: abortedNow });
  }

  /** 读新输出（可选写 stdin）；进程未退出时最多等 yieldMs 等产出 */
  async function writeStdin({ process_id, chars, yield_ms } = {}) {
    const id = toId(process_id);
    const rec = sessions.get(id);
    if (!rec) return formatUnknown(id);
    let wrote = 0;
    const hasChars = typeof chars === 'string' && chars.length > 0;
    if (hasChars && rec.status === 'running' && rec.child.stdin?.writable) {
      try {
        rec.child.stdin.write(chars);
        wrote = chars.length;
      } catch {
        /* 写失败（EPIPE 等）不影响读取 */
      }
    }
    if (rec.status === 'running' && !signal?.aborted) {
      await Promise.race([rec.closed, sleep(clampYieldMs(yield_ms, SESSIONS.WRITE_DEFAULT_YIELD_MS)), abortPromise]);
    }
    const note = hasChars && wrote === 0 ? '（进程已退出或 stdin 不可用：输入未写入）' : '';
    return formatWriteResult({ rec, output: bufferDrain(rec.buffer).text, wrote, note });
  }

  function listProcesses() {
    const rows = [...sessions.values()].map((r) => ({
      id: r.id,
      command: clip(r.command, 60),
      statusLabelText: listStatusText(r),
      unread: r.buffer.text.length + r.buffer.dropped,
      elapsedMs: Date.now() - r.startedAt,
    }));
    return formatList(rows);
  }

  async function killProcess({ process_id } = {}) {
    const id = toId(process_id);
    const rec = sessions.get(id);
    if (!rec) return formatUnknown(id);
    if (rec.status === 'running' && !rec.terminating) {
      rec.terminating = true;
      rec.killRequested = true;
      killTree(rec.child);
      await Promise.race([rec.closed, sleep(2000)]); // 等 close（kill 的发出 ≠ 进程已死）
      if (!rec.closeSettled) finalize(rec, null); // close 不来（孙进程持管道）：兜底结算
    }
    return formatKillResult({ rec, output: bufferDrain(rec.buffer).text });
  }

  async function executeTool(name, input) {
    const fn = {
      exec_command: execCommand,
      write_stdin: writeStdin,
      list_processes: listProcesses,
      kill_process: killProcess,
    }[name];
    if (!fn) throw new Error(`未知的会话工具：${name}`);
    return fn(input || {});
  }

  return {
    toolDefs: TOOL_DEFS,
    executeTool,
    terminateAll,
    list: listProcesses,
    size: () => sessions.size,
    // 内部方法（单测直接驱动；入口只走 executeTool）
    execCommand,
    writeStdin,
    killProcess,
  };
}
