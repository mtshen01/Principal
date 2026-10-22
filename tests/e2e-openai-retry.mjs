/**
 * openai 模型流重试 e2e（P0-④）：真 web 进程 + 会「挂起」的假 OpenAI 兼容端点。
 *
 * 守的不变量 ——
 * ① 流空闲判死（env 把 MODEL_STREAM_IDLE_MS 压到 700ms）后，**循环内**重建请求重试
 *   （不落 run 级对账：一次网络抖动不该赔上一次完整续跑）；
 * ② 重试成功不产生重复回复（失败尝试不落账）；
 * ③ journal 落 model_retry（kind=idle）且 settled(done) 完整；
 * ④ 走崩溃遗留 run-index 的对账续跑触发（复刻 e2e-openai-resume 的路径）。
 *
 * 自起独立 web 服务器（mkdtemp 临时 APP_DATA_DIR + 内核分配的空闲端口），**绝不触碰 pm2 的
 * 3000 端口与仓库根数据目录**（同 e2e-openai-resume.mjs 范式）。
 * 运行：node tests/e2e-openai-retry.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL: ' + msg);
};
const step = (msg) => console.log('  ✔ ' + msg);

/** 找一个当前空闲端口：临时监听 0 号端口由内核分配后立即关闭，复用其号码给待起的子进程。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForReady(baseUrl, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(baseUrl + '/api/ping');
      if (r.ok) return true;
    } catch {
      /* 还没监听上，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const port = Number(process.env.E2E_PORT) || (await findFreePort());
const BASE = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-retry-e2e-'));

// ---- 假 OpenAI 兼容端点：第 1 次请求「挂起」（发头不给事件），第 2 次正常回复 ----
let modelRequests = 0;
const fakeModel = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    modelRequests++;
    const n = modelRequests;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (n === 1) {
        // 挂起：连接保持、永不吐事件——只有空闲判死能把它拉回来（run 看门狗 15min 太久）
        console.log('  模型第 1 次调用：挂起（等待空闲判死）…');
        return;
      }
      console.log(`  模型第 ${n} 次调用：正常回复`);
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: '重试成功' }, finish_reason: null }],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }) +
          '\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => fakeModel.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${fakeModel.address().port}/v1`;

// ---- 播种（必须在 server 启动前）：凭证 + 检查点 + 崩溃遗留索引 ----
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify(
    {
      tokens: [
        {
          id: 'tk_e2e',
          providerId: 'openai-compat',
          label: 'e2e 假模型',
          token: 'sk-e2e-not-real',
          baseURL,
          model: 'test-model',
          status: 'healthy',
        },
      ],
      builtinMcp: { context7: { enabled: false } }, // 不拉 npx 子进程
      repoMap: { enabled: false }, // 不扫仓库
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(dataDir, 'conv-messages.json'),
  JSON.stringify({ c_e2e: [{ role: 'user', content: '开始一个任务' }] }),
);
fs.writeFileSync(
  path.join(dataDir, 'run-index.json'),
  JSON.stringify([
    {
      runId: 'run_dead_retry',
      convId: 'c_e2e',
      provider: 'openai-compat',
      session_id: null,
      cwd: REPO_ROOT,
      model: 'test-model',
      credId: 'tk_e2e',
      requestId: null,
      prompt: '开始一个任务',
      resumeAttempt: 0,
      pid: 999999, // 必死 pid：对账按孤儿回收
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      lastSeq: 1,
    },
  ]),
);

let child = null;
try {
  child = spawn(process.execPath, ['src/entrypoints/web/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      APP_DATA_DIR: dataDir,
      // 把重试与空闲压到亚秒级（默认 120s/2s 没法在 e2e 里等；口径见 spec §3 拍板 7）
      MODEL_STREAM_IDLE_MS: '700',
      MODEL_STREAM_RETRY_BASE_MS: '50',
      MODEL_STREAM_RETRY_MAX: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', (d) => (serverOutput += d));
  child.stderr.on('data', (d) => (serverOutput += d));

  if (!(await waitForReady(BASE))) throw new Error('自起的 web 服务器未在 20s 内就绪，输出：\n' + serverOutput);
  step('web 已就绪（对账在 listen 回调内已调度续跑）');

  // 等续跑 + 空闲判死 + 重试完成（3s 调度延迟 + ~0.7s 空闲 + 50ms 退避）
  const deadline = Date.now() + 20000;
  let msgs = [];
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'conv-messages.json'), 'utf8')).c_e2e;
      msgs = Array.isArray(raw) ? raw : raw?.messages || [];
    } catch {
      msgs = [];
    }
    if (msgs.length >= 2 && msgs[msgs.length - 1].role === 'assistant') break;
    await new Promise((r) => setTimeout(r, 300));
  }

  // ① 挂起 → 判死 → 重建请求：恰好两次模型调用
  if (modelRequests !== 2) fail(`模型应被调用恰好 2 次（第 1 次挂起被空闲判死），实际 ${modelRequests} 次`);
  else step('挂起流被判死后重建请求重试：模型调用恰好 2 次');

  // ② 重试成功且不重复落账
  const last = msgs[msgs.length - 1];
  if (!(last && last.role === 'assistant' && JSON.stringify(last).includes('重试成功'))) {
    fail('模型重试回复未落盘：' + JSON.stringify(last));
  } else {
    step('重试回复已落盘：' + last.content[0].text);
  }
  const hitCount = msgs.filter((m) => JSON.stringify(m).includes('重试成功')).length;
  if (hitCount !== 1) fail(`重试不得产生重复回复，实际命中 ${hitCount} 条`);
  else step('无重复回复（失败尝试不落账）');

  // ③④ journal + 索引收尾
  const journal = fs
    .readFileSync(path.join(dataDir, 'run-journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const retryEv = journal.find((e) => e.type === 'model_retry');
  if (!retryEv) fail(`journal 缺 model_retry（实际 ${journal.map((e) => e.type).join(',')}）`);
  else if (retryEv.data.kind !== 'idle') fail('model_retry.kind 应为 idle：' + JSON.stringify(retryEv.data));
  else step('journal：model_retry(kind=idle) 已落');
  const settled = journal.find((e) => e.type === 'settled');
  if (!settled || settled.data.status !== 'done') fail('settled 非 done：' + JSON.stringify(settled));
  else step('journal：settled(done)');

  const left = JSON.parse(fs.readFileSync(path.join(dataDir, 'run-index.json'), 'utf8'));
  if (left.length) fail('run-index 未清空：' + JSON.stringify(left));
  else step('run-index 已清空');

  console.log(
    failures
      ? `E2E FAIL（${failures} 处）`
      : 'E2E PASS：模型流空闲判死 → 循环内重建请求重试（无重复回复、journal/索引完整）',
  );
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('FAIL(异常): ' + (e && e.stack ? e.stack : String(e)));
  process.exitCode = 1;
} finally {
  if (child) child.kill();
  fakeModel.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响测试结果 */
  }
}
