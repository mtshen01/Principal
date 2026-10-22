/**
 * 设置路由的「功能模型」链路测试（2026-10-10 功能模型需求）：
 *   - GET /api/settings 的 tokens 只回 Claude 订阅账号（openai 凭证不得泄漏进「订阅 Key」列表）；
 *   - POST section=tokens 的响应同样过滤；
 *   - POST section=model-tasks：单条覆盖写 / null 清除 / 未知 id 与非法形状 400。
 * 走临时 APP_DATA_DIR + 内存 req/res，零网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-settings-mt-'));

const { handleSettings } = await import('./routes-settings.js');
const { addTokenEntry } = await import('../../store/settings.js');

function mockReq(method, body) {
  const r = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]);
  r.method = method;
  return r;
}
function mockRes() {
  const cap = { code: 0, body: null };
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code) {
      cap.code = code;
      res.headersSent = true;
    },
    end(text) {
      cap.body = text ? JSON.parse(text) : null;
    },
  };
  return { res, cap };
}
async function get() {
  const { res, cap } = mockRes();
  await handleSettings(mockReq('GET'), res);
  return cap;
}
async function post(body) {
  const { res, cap } = mockRes();
  await handleSettings(mockReq('POST', body), res);
  return cap;
}

// 先铺底：一个 Claude 订阅号 + 一个 openai 凭证（后者不得出现在任何 tokens 列表里）
addTokenEntry('订阅号', 'sk-ant-oat01-test', undefined);
const openaiCred = addTokenEntry('DeepSeek', 'sk-ds-test', 'openai-compat', {
  baseURL: 'https://api.deepseek.com/v1',
  vendor: 'deepseek',
});

test('GET：tokens 只含 Claude 订阅（openai 凭证不混入订阅列表）', async () => {
  const cap = await get();
  assert.equal(cap.code, 200);
  assert.ok(Array.isArray(cap.body.tokens));
  assert.ok(cap.body.tokens.length >= 1);
  assert.ok(
    cap.body.tokens.every((t) => t.providerId === 'claude-agent'),
    '订阅列表出现非 claude-agent 条目 = 用户报障的泄漏回归',
  );
  assert.ok(!cap.body.tokens.some((t) => t.id === openaiCred.id));
});

test('POST tokens：响应 tokens 同样过滤；modelTasks 视图随 GET 下发', async () => {
  const cap = await post({ section: 'tokens', action: 'add', label: '二号', token: 'sk-ant-oat01-test2' });
  assert.equal(cap.code, 200);
  assert.ok(cap.body.tokens.every((t) => t.providerId === 'claude-agent'));
  assert.ok(!cap.body.tokens.some((t) => t.id === openaiCred.id));

  const g = await get();
  assert.ok(Array.isArray(g.body.modelTasks) && g.body.modelTasks.length > 0, 'GET 下发功能模型视图');
  const intent = g.body.modelTasks.find((v) => v.id === 'intent');
  assert.ok(intent && intent.fallback && 'value' in intent);
});

test('POST model-tasks：覆盖写 → GET 可见；null 清除 → 回落 null', async () => {
  const cap = await post({
    section: 'model-tasks',
    id: 'intent',
    value: { provider: 'openai-compat', credId: openaiCred.id, model: 'deepseek-chat' },
  });
  assert.equal(cap.code, 200);
  const item = cap.body.modelTasks.find((v) => v.id === 'intent');
  assert.deepEqual(item.value, {
    provider: 'openai-compat',
    credId: openaiCred.id,
    model: 'deepseek-chat',
  });

  const g = await get();
  assert.deepEqual(g.body.modelTasks.find((v) => v.id === 'intent').value, {
    provider: 'openai-compat',
    credId: openaiCred.id,
    model: 'deepseek-chat',
  });

  const clr = await post({ section: 'model-tasks', id: 'intent', value: null });
  assert.equal(clr.code, 200);
  assert.equal(clr.body.modelTasks.find((v) => v.id === 'intent').value, null, '清除后 value 回落 null');
});

test('POST model-tasks：未知 id / 非法形状 → 400，不落盘', async () => {
  const bad = await post({ section: 'model-tasks', id: 'nope', value: { provider: 'claude-agent', model: 'x' } });
  assert.equal(bad.code, 400);

  const badShape = await post({ section: 'model-tasks', id: 'review', value: { provider: 'claude-agent' } });
  assert.equal(badShape.code, 400);

  const g = await get();
  assert.equal(g.body.modelTasks.find((v) => v.id === 'review').value, null, '非法形状不得留下半截配置');
});
