import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRY_DEFAULTS,
  resolveRetryOptions,
  nextRetryDelayMs,
  classifyModelError,
  describeRetryKind,
  formatRetryDelay,
} from './model-retry.logic.js';

// ── resolveRetryOptions：显式 > env > 默认（非法值一律回落）──────────────

test('resolveRetryOptions：无入参 → 默认值', () => {
  assert.deepEqual(resolveRetryOptions(undefined, {}), {
    maxRetries: 5,
    initialDelayMs: 2000,
    maxDelayMs: 60000,
    streamIdleMs: 120000,
  });
  assert.deepEqual(resolveRetryOptions({}, {}), RETRY_DEFAULTS, '空对象同样是默认');
});

test('resolveRetryOptions：显式覆盖 + 数字字符串归一', () => {
  const r = resolveRetryOptions({ maxRetries: '2', initialDelayMs: 10, maxDelayMs: 50, streamIdleMs: 80 }, {});
  assert.deepEqual(r, { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 50, streamIdleMs: 80 });
});

test('resolveRetryOptions：env 覆盖默认；显式优先于 env', () => {
  const env = {
    MODEL_STREAM_RETRY_MAX: '1',
    MODEL_STREAM_RETRY_BASE_MS: '50',
    MODEL_STREAM_RETRY_MAX_MS: '500',
    MODEL_STREAM_IDLE_MS: '600',
  };
  assert.deepEqual(resolveRetryOptions(undefined, env), { maxRetries: 1, initialDelayMs: 50, maxDelayMs: 500, streamIdleMs: 600 });
  assert.deepEqual(resolveRetryOptions({ streamIdleMs: 42 }, env).streamIdleMs, 42);
});

test('resolveRetryOptions：非法值回落（NaN/负数；正数项 0 也回落）；maxRetries 0 合法 = 不重试', () => {
  const r = resolveRetryOptions({ maxRetries: 0, initialDelayMs: -1, maxDelayMs: Number.NaN, streamIdleMs: 0 }, { MODEL_STREAM_RETRY_BASE_MS: 'abc' });
  assert.deepEqual(r, { maxRetries: 0, initialDelayMs: 2000, maxDelayMs: 60000, streamIdleMs: 120000 });
});

// ── nextRetryDelayMs：指数退避 + 封顶 ────────────────────────────────

test('nextRetryDelayMs：2s 起步逐次翻倍，60s 封顶', () => {
  const opts = { initialDelayMs: 2000, maxDelayMs: 60000 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 20].map((n) => nextRetryDelayMs(n, opts)),
    [2000, 4000, 8000, 16000, 32000, 60000, 60000],
  );
});

test('nextRetryDelayMs：自定义起步/封顶生效（e2e 的亚秒级配置）', () => {
  const opts = { initialDelayMs: 50, maxDelayMs: 200 };
  assert.deepEqual([1, 2, 3].map((n) => nextRetryDelayMs(n, opts)), [50, 100, 200]);
});

// ── classifyModelError：白名单式可重试判定 ───────────────────────────

test('classifyModelError：用户中断优先，一切不重试', () => {
  assert.deepEqual(classifyModelError(new Error('fetch failed'), { aborted: true }), { retryable: false, kind: 'aborted' });
  assert.deepEqual(classifyModelError({ statusCode: 503 }, { aborted: true }), { retryable: false, kind: 'aborted' });
});

test('classifyModelError：自产标记错误（空闲判死/finishReason=error）不依赖文案', () => {
  const idle = new Error('模型流空闲超时（120000ms 未收到任何事件）');
  idle.code = 'stream_idle';
  assert.deepEqual(classifyModelError(idle), { retryable: true, kind: 'idle' });
  const fin = new Error('模型以错误结束（finishReason=error）');
  fin.code = 'model_finish_error';
  assert.deepEqual(classifyModelError(fin), { retryable: true, kind: 'finish' });
});

test('classifyModelError：AI SDK isRetryable 最权威', () => {
  const yes = new Error('boom');
  yes.isRetryable = true;
  assert.deepEqual(classifyModelError(yes), { retryable: true, kind: 'api' });
  const no = new Error('boom');
  no.isRetryable = false;
  assert.deepEqual(classifyModelError(no), { retryable: false, kind: 'api' });
});

test('classifyModelError：statusCode 判定（408/409/429/5xx 可重试；其余 4xx 不可）', () => {
  for (const s of [408, 409, 429, 500, 502, 503]) {
    assert.deepEqual(classifyModelError({ statusCode: s, message: 'x' }), { retryable: true, kind: 'http' }, `HTTP ${s} 应可重试`);
  }
  for (const s of [400, 401, 403, 404, 422]) {
    assert.deepEqual(classifyModelError({ statusCode: s, message: 'x' }), { retryable: false, kind: 'http' }, `HTTP ${s} 不应重试`);
  }
});

test('classifyModelError：状态码藏在文案里（无 statusCode 字段时的兜底）', () => {
  assert.deepEqual(classifyModelError(new Error('APICallError: response status 502 Bad Gateway')), { retryable: true, kind: 'http' });
  assert.deepEqual(classifyModelError(new Error('rate limited (429), retry later')), { retryable: true, kind: 'http' });
  assert.deepEqual(classifyModelError(new Error('400 Bad Request: invalid message role')), { retryable: false, kind: 'http' });
});

test('classifyModelError：网络断流措辞可重试', () => {
  for (const msg of ['fetch failed', 'read ECONNRESET', 'socket hang up', 'other side closed', 'premature close', 'terminated', 'UND_ERR_SOCKET']) {
    assert.deepEqual(classifyModelError(new Error(msg)), { retryable: true, kind: 'network' }, `${msg} 应可重试`);
  }
});

test('classifyModelError：未知错误/校验类一律不重试（重试也修不好）', () => {
  for (const msg of ['net down', 'InvalidPromptError: messages are malformed', 'boom', 'The operation was aborted']) {
    assert.deepEqual(classifyModelError(new Error(msg)), { retryable: false, kind: 'other' }, `${msg} 不应重试`);
  }
  assert.deepEqual(classifyModelError(undefined), { retryable: false, kind: 'other' }, '空错误不崩、不重试');
  assert.deepEqual(classifyModelError('字符串错误'), { retryable: false, kind: 'other' });
});

// ── 文案 ────────────────────────────────────────────────────────────

test('describeRetryKind：已知类别中文；未知/空回落「未知错误」', () => {
  assert.equal(describeRetryKind('idle'), '流空闲超时');
  assert.equal(describeRetryKind('network'), '网络中断');
  assert.equal(describeRetryKind('finish'), '模型异常结束');
  assert.equal(describeRetryKind('nope'), '未知错误');
  assert.equal(describeRetryKind(undefined), '未知错误');
});

test('formatRetryDelay：秒/毫秒两档', () => {
  assert.equal(formatRetryDelay(2000), '2 秒');
  assert.equal(formatRetryDelay(60000), '60 秒');
  assert.equal(formatRetryDelay(1500), '1.5 秒');
  assert.equal(formatRetryDelay(500), '500 毫秒');
  assert.equal(formatRetryDelay(0), '0 毫秒');
});
