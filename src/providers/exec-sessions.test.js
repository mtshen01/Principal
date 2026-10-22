/**
 * 命令会话管理器（P1-6）运行时单测：真 spawn、真轮询、真杀树。
 * 夹具脚本写在临时工作区里（同 builtin-tools.test.js 风格——不拿仓库当实验场）。
 * 纪律：每个用例注册 t.after(terminateAll)——留活子进程会让 test runner 等管道挂死。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecSessions, EXEC_SESSION_TOOL_NAMES } from './exec-sessions.js';

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-sessions-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'quick.js'), "console.log('hello from quick');\n");
  fs.writeFileSync(path.join(dir, 'fail.js'), "console.error('boom on stderr');\nprocess.exit(2);\n");
  fs.writeFileSync(
    path.join(dir, 'slow.js'),
    "console.log('boot');\nlet n = 0;\nsetInterval(() => { console.log('tick ' + (++n)); }, 60);\n",
  );
  fs.writeFileSync(
    path.join(dir, 'echo.js'),
    "const rl = require('node:readline').createInterface({ input: process.stdin });\n" +
      "rl.on('line', (l) => { console.log('got:' + l.trim()); if (l.trim() === 'quit') process.exit(0); });\n" +
      "console.log('ready');\n",
  );
  fs.writeFileSync(path.join(dir, 'flood.js'), "process.stdout.write('A'.repeat(20000));\n");
  return dir;
}

/** 建管理器并挂收尾（幂等杀全部会话） */
function makeMgr(t, opts) {
  const mgr = createExecSessions(opts);
  t.after(() => mgr.terminateAll());
  return mgr;
}

/** 轮询等待（避免对子进程退出/close 时序做硬编码 sleep 假设） */
async function waitFor(fn, { timeoutMs = 5000, stepMs = 80 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const cmdFor = (ws, file) => `node "${path.join(ws, file)}"`;

test('exec_command：快速命令直接返回输出与退出码', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  const out = await mgr.execCommand({ command: cmdFor(ws, 'quick.js') });
  assert.match(out, /【进程 #1 · 已退出（退出码 0/);
  assert.match(out, /hello from quick/);
  assert.ok(!out.includes('write_stdin'), '已退出不再引导轮询');
  assert.equal(mgr.size(), 1, '已退出的会话保留输出直到回收/run 结束');
});

test('exec_command：stderr 与退出码落进同一缓冲', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  const out = await mgr.execCommand({ command: cmdFor(ws, 'fail.js') });
  assert.match(out, /已退出（退出码 2/);
  assert.match(out, /boom on stderr/);
});

test('exec_command：长进程超时返回进程号，write_stdin 增量读到后续输出，kill_process 终止', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  const first = await mgr.execCommand({ command: cmdFor(ws, 'slow.js'), yield_ms: 300 });
  assert.match(first, /【进程 #1 · 运行中/);
  assert.match(first, /boot/);
  assert.match(first, /write_stdin process_id=1/);

  const second = await mgr.writeStdin({ process_id: 1, yield_ms: 300 });
  assert.match(second, /【进程 #1 · 运行中/);
  assert.match(second, /tick \d+/, '轮询应拿到新输出');

  const killed = await mgr.killProcess({ process_id: 1 });
  assert.match(killed, /【进程 #1 · 已终止（kill_process）/);
});

test('write_stdin：写入 stdin 得到应答；quit 后进程退出，仍可读收尾输出', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  const started = await mgr.execCommand({ command: cmdFor(ws, 'echo.js'), yield_ms: 300 });
  assert.match(started, /运行中/);
  assert.match(started, /ready/);

  const r1 = await mgr.writeStdin({ process_id: 1, chars: 'hello\n', yield_ms: 800 });
  assert.match(r1, /已写入 6 字符/);
  assert.match(r1, /got:hello/);

  const r2 = await mgr.writeStdin({ process_id: 1, chars: 'quit\n', yield_ms: 1500 });
  assert.match(r2, /已退出（退出码 0/);
  assert.match(r2, /got:quit/);
  // 已退出后再写：不炸，明确说没写进去
  const r3 = await mgr.writeStdin({ process_id: 1, chars: 'x\n' });
  assert.match(r3, /输入未写入/);
});

test('write_stdin / kill_process：失联进程号给回收文案', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  assert.match(await mgr.writeStdin({ process_id: 42 }), /找不到进程 #42/);
  assert.match(await mgr.killProcess({ process_id: 42 }), /找不到进程 #42/);
});

test('输出缓冲：大输出按 8K 消费，剩余提示续读', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  const out = await mgr.execCommand({ command: cmdFor(ws, 'flood.js') });
  assert.match(out, /已退出（退出码 0/);
  assert.match(out, /还有 12000 字未读输出/);
  const rest = await mgr.writeStdin({ process_id: 1, yield_ms: 250 });
  assert.match(rest, /还有 4000 字未读输出/);
});

test('list_processes：空表/在跑/已退出三态', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  assert.match(await mgr.executeTool('list_processes', {}), /当前没有后台命令/);
  await mgr.execCommand({ command: cmdFor(ws, 'quick.js') });
  await mgr.execCommand({ command: cmdFor(ws, 'slow.js'), yield_ms: 300 });
  const list = await mgr.executeTool('list_processes', {});
  assert.match(list, /后台命令（2\/8）/);
  assert.match(list, /#1 已退出\(码 0\)/);
  assert.match(list, /#2 运行中/);
  const err = await mgr.executeTool('nope', {}).then(() => null, (e) => e);
  assert.match(String(err?.message), /未知的会话工具/);
});

test('上限：8 个在跑时拒绝第 9 个；杀掉一个后可启动（回收已退出会话腾位）', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  for (let i = 0; i < 8; i++) {
    const out = await mgr.execCommand({ command: cmdFor(ws, 'slow.js'), yield_ms: 250 });
    assert.match(out, /运行中/);
  }
  const ninth = await mgr.execCommand({ command: cmdFor(ws, 'quick.js'), yield_ms: 250 });
  assert.match(ninth, /已达上限（8 个且都在运行）/);

  await mgr.killProcess({ process_id: 1 });
  const afterKill = await mgr.execCommand({ command: cmdFor(ws, 'quick.js'), yield_ms: 250 });
  assert.match(afterKill, /【进程 #9 · 已退出（退出码 0/, '回收 #1 的槽位后新会话可用');
});

test('terminateAll：杀全部活动会话、幂等；收尾后 write_stdin 显示已终止', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws });
  await mgr.execCommand({ command: cmdFor(ws, 'slow.js'), yield_ms: 250 });
  await mgr.execCommand({ command: cmdFor(ws, 'slow.js'), yield_ms: 250 });
  mgr.terminateAll();
  mgr.terminateAll(); // 幂等
  const settled = await waitFor(async () => {
    const out = await mgr.writeStdin({ process_id: 1 });
    return out.includes('已终止') ? out : null;
  });
  assert.ok(settled, 'terminateAll 后会话应在宽限内结算为已终止');
  assert.match(await mgr.writeStdin({ process_id: 2 }), /已终止/);
});

test('abort：run 被停止 → 秒杀全部会话；之后不再接受新命令', async (t) => {
  const ws = makeWorkspace();
  const ac = new AbortController();
  const mgr = makeMgr(t, { cwd: ws, signal: ac.signal });
  await mgr.execCommand({ command: cmdFor(ws, 'slow.js'), yield_ms: 250 });
  ac.abort();
  const settled = await waitFor(async () => {
    const out = await mgr.writeStdin({ process_id: 1 });
    return out.includes('已终止') ? out : null;
  });
  assert.ok(settled, 'abort 应触发 terminateAll');
  assert.match(await mgr.execCommand({ command: cmdFor(ws, 'quick.js') }), /运行已被停止/);
});

test('unavailable 后端：fail-closed 明确报错（不静默回本地）', async (t) => {
  const ws = makeWorkspace();
  const mgr = makeMgr(t, { cwd: ws, bashBackend: { kind: 'unavailable', reason: '未检测到 docker' } });
  const out = await mgr.execCommand({ command: cmdFor(ws, 'quick.js') });
  assert.match(out, /后台命令当前不可用：未检测到 docker/);
  assert.equal(mgr.size(), 0);
});

test('工具定义与名字清单：四件套齐备且名字与 disabled 展开共用同一份', () => {
  const mgr = createExecSessions({ cwd: '.' });
  assert.deepEqual(Object.keys(mgr.toolDefs).sort(), ['exec_command', 'kill_process', 'list_processes', 'write_stdin']);
  assert.deepEqual(Object.keys(mgr.toolDefs).sort(), [...EXEC_SESSION_TOOL_NAMES].sort());
  for (const def of Object.values(mgr.toolDefs)) {
    assert.equal(typeof def.description, 'string');
    assert.ok(def.inputSchema, 'inputSchema 必须是 zod schema');
  }
});
