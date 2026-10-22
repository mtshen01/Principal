/**
 * 命令会话管理（P1-6）纯函数层单测：缓冲剪中段 / 消费式读取 / yield 夹取 / 文案。
 * 口径见 docs/superpowers/specs/2026-10-11-exec-sessions-design.md。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSIONS,
  createBuffer,
  bufferAppend,
  bufferDrain,
  clampYieldMs,
  statusLabel,
  formatUnknown,
  formatBackendUnavailable,
  formatAtCapacity,
  formatRunAborted,
  formatExecStart,
  formatWriteResult,
  formatKillResult,
  formatList,
  listStatusText,
  buildExecSessionsPrompt,
} from './exec-sessions.logic.js';

// ---------- 缓冲 ----------

test('bufferDrain：未溢出时按 cap 消费，剩余带续读提示', () => {
  const b = createBuffer();
  bufferAppend(b, 'x'.repeat(20_000));
  const first = bufferDrain(b);
  assert.equal(first.delivered, SESSIONS.READ_CAP_CHARS, '单次读取正文 ≤ 8K 字');
  assert.equal(first.remaining, 20_000 - SESSIONS.READ_CAP_CHARS);
  assert.match(first.text, /还有 \d+ 字未读输出，再次 write_stdin 续读/, '剩余要显式提示');
  const second = bufferDrain(b);
  assert.equal(second.remaining, 20_000 - 2 * SESSIONS.READ_CAP_CHARS);
  assert.equal(b.dropped, 0);
});

test('bufferAppend：超限剪中段——保留头尾，丢弃量累计', () => {
  const b = createBuffer();
  const head = 'H'.repeat(SESSIONS.HEAD_KEEP_CHARS);
  const mid = 'M'.repeat(50_000);
  const tail = 'T'.repeat(SESSIONS.TAIL_KEEP_CHARS);
  bufferAppend(b, head + mid + tail);
  assert.equal(b.text.length, SESSIONS.HEAD_KEEP_CHARS + SESSIONS.TAIL_KEEP_CHARS, '缓冲有界');
  assert.equal(b.dropped, 50_000, '中段丢弃量被累计');
  assert.ok(b.text.startsWith('HHHH'), '头部保留（早期错误/命令回显）');
  assert.ok(b.text.endsWith('TTTT'), '尾部保留（最新进展）');

  const out = bufferDrain(b);
  assert.match(out.text, /^…（中间省略 50000 字未读输出）…\n/, '丢弃要在下一次读取时显式报告');
  assert.equal(out.dropped, 50_000);
  // 丢弃量只报告一次
  const again = bufferDrain(b);
  assert.ok(!again.text.includes('中间省略'));
});

test('bufferAppend/bufferDrain：空输入不动状态；cap 非法回退缺省', () => {
  const b = createBuffer();
  bufferAppend(b, '');
  bufferAppend(b, null);
  assert.equal(b.text, '');
  bufferAppend(b, 'abc');
  assert.equal(bufferDrain(b, 0).text, 'abc', 'cap 非法按缺省处理');
  assert.equal(bufferDrain(b).text, '', '读空不炸');
});

// ---------- yield 夹取 ----------

test('clampYieldMs：非数值回退，数值一律夹到 [250, 30000]', () => {
  assert.equal(clampYieldMs(undefined), SESSIONS.DEFAULT_YIELD_MS);
  assert.equal(clampYieldMs(undefined, SESSIONS.WRITE_DEFAULT_YIELD_MS), SESSIONS.WRITE_DEFAULT_YIELD_MS);
  assert.equal(clampYieldMs('abc'), SESSIONS.DEFAULT_YIELD_MS);
  assert.equal(clampYieldMs(NaN), SESSIONS.DEFAULT_YIELD_MS);
  assert.equal(clampYieldMs(-5), SESSIONS.MIN_YIELD_MS);
  assert.equal(clampYieldMs(0), SESSIONS.MIN_YIELD_MS);
  assert.equal(clampYieldMs(1), SESSIONS.MIN_YIELD_MS);
  assert.equal(clampYieldMs(999_999), SESSIONS.MAX_YIELD_MS);
  assert.equal(clampYieldMs(1234.6), 1235);
});

// ---------- 文案 ----------

const rec = (over = {}) => ({
  id: 3,
  command: 'npm run dev',
  status: 'running',
  code: null,
  startedAt: Date.now() - 1200,
  exitedAt: Date.now(),
  ...over,
});

test('statusLabel：运行中带时长；已退出带退出码；已终止单列', () => {
  assert.match(statusLabel(rec()), /运行中（已运行 1\.[12]s）/);
  assert.match(statusLabel(rec({ status: 'exited', code: 0 })), /已退出（退出码 0，耗时 1\.[12]s）/);
  assert.match(statusLabel(rec({ status: 'killed' })), /已终止/);
  assert.equal(listStatusText(rec()), '运行中');
  assert.equal(listStatusText(rec({ status: 'exited', code: 2 })), '已退出(码 2)');
  assert.equal(listStatusText(rec({ status: 'killed' })), '已终止');
});

test('formatExecStart：运行中带 process_id 指引；已退出不带；被停止有专属文案', () => {
  const running = formatExecStart({ rec: rec(), output: 'listening on :3000' });
  assert.match(running, /【进程 #3 · 运行中/);
  assert.match(running, /write_stdin process_id=3/);
  assert.match(running, /kill_process/);
  const exited = formatExecStart({ rec: rec({ status: 'exited', code: 1 }), output: '' });
  assert.match(exited, /【进程 #3 · 已退出（退出码 1/);
  assert.match(exited, /（暂无输出）/);
  assert.ok(!exited.includes('write_stdin'), '已退出不再引导轮询');
  const aborted = formatExecStart({ rec: rec(), aborted: true });
  assert.match(aborted, /已被停止/);
});

test('formatWriteResult：写入量/未写入附注/无输出兜底', () => {
  const withOut = formatWriteResult({ rec: rec(), output: 'compiled ok', wrote: 4 });
  assert.match(withOut, /已写入 4 字符/);
  assert.match(withOut, /compiled ok/);
  const empty = formatWriteResult({ rec: rec(), output: '', wrote: 0 });
  assert.match(empty, /暂无新输出/);
  const note = formatWriteResult({ rec: rec({ status: 'exited', code: 0 }), output: '', wrote: 0, note: '（进程已退出或 stdin 不可用：输入未写入）' });
  assert.match(note, /输入未写入/);
  assert.ok(!note.includes('继续用 write_stdin 轮询'), '已退出不引导继续轮询');
});

test('formatKillResult / formatList / 其它口径文案', () => {
  assert.match(formatKillResult({ rec: rec({ status: 'killed' }), output: 'bye' }), /已终止（kill_process）/);
  const list = formatList([
    { id: 1, command: 'npm run dev', statusLabelText: '运行中', unread: 12, elapsedMs: 3000 },
    { id: 2, command: 'node x.js', statusLabelText: '已退出(码 0)', unread: 0, elapsedMs: 800 },
  ]);
  assert.match(list, /后台命令（2\/8）/);
  assert.match(list, /#1 运行中：npm run dev（未读 12 字/);
  assert.equal(formatList([]), '（当前没有后台命令——用 exec_command 启动）');
  assert.match(formatUnknown(9), /找不到进程 #9/);
  assert.match(formatAtCapacity(8), /已达上限（8 个且都在运行）/);
  assert.match(formatBackendUnavailable('无 docker'), /后台命令当前不可用：无 docker/);
  assert.match(formatRunAborted(), /运行已被停止/);
});

test('buildExecSessionsPrompt：提到 exec_command / write_stdin / kill_process 且说明 run 结束自动终止', () => {
  const p = buildExecSessionsPrompt();
  for (const k of ['exec_command', 'write_stdin', 'kill_process', '自动终止']) assert.ok(p.includes(k), `应提到 ${k}`);
});
