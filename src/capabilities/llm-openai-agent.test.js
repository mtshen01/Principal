/**
 * 自定义模型执行通道（llm-openai-agent）的零网络测试：
 *   - resolveApiCred：按凭证 id 解析接入信息（不存在 / 非 openai / 缺字段 → null）；
 *   - runOpenAiOnce / runOpenAiAgentTurn：凭证缺失或模型为空 → 立即返回 no-credential，
 *     不发起任何网络请求、不产生副作用（调用方按失败语义兜底）。
 *
 * 真实模型调用链路（stream/modelRun）由 providers 侧既有测试覆盖；这里只守「短路语义」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-openai-agent-'));

const { resolveApiCred, runOpenAiOnce, runOpenAiAgentTurn } = await import('./llm-openai-agent.js');
const { addTokenEntry } = await import('../store/settings.js');

test('resolveApiCred：不存在 / 非 openai / 缺字段 → null；合法凭证原样返回', () => {
  assert.equal(resolveApiCred('tk_nope'), null);

  const claude = addTokenEntry('订阅', 'sk-ant-oat', undefined);
  assert.equal(resolveApiCred(claude.id), null, 'Claude 订阅凭证不是 openai 目标');

  const noBase = addTokenEntry('缺 baseURL', 'sk-x', 'openai-compat', {});
  assert.equal(resolveApiCred(noBase.id), null);

  const ok = addTokenEntry('DeepSeek', ' sk-ds ', 'openai-compat', { baseURL: ' https://api.deepseek.com/v1 ' });
  assert.deepEqual(resolveApiCred(ok.id), { apiKey: 'sk-ds', baseURL: 'https://api.deepseek.com/v1' });
});

test('runOpenAiOnce：凭证缺失/模型为空 → 零网络 no-credential', async () => {
  assert.deepEqual(await runOpenAiOnce({ credId: 'tk_missing', model: 'deepseek-chat', prompt: 'hi' }), {
    text: '',
    reason: 'no-credential',
  });
  const ok = addTokenEntry('DS-once', 'sk-ds', 'openai-compat', { baseURL: 'https://api.deepseek.com/v1' });
  assert.deepEqual(await runOpenAiOnce({ credId: ok.id, model: '', prompt: 'hi' }), {
    text: '',
    reason: 'no-credential',
  });
});

test('runOpenAiAgentTurn：凭证缺失 → no-credential 空结果（形状稳定，调用方无需判空）', async () => {
  const r = await runOpenAiAgentTurn({
    credId: 'tk_missing',
    model: 'deepseek-chat',
    prompt: 'hi',
    cwd: process.cwd(),
    mode: 'readonly',
  });
  assert.equal(r.reason, 'no-credential');
  assert.equal(r.result, '');
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.toolTrace, []);
  assert.deepEqual(r.wrote, []);
  assert.deepEqual(r.denied, []);
});
