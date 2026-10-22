/**
 * 模型列表拉取纯函数单测：端点拼接（协议/幂等）与响应解析（多形状/去重/上限）。
 * 这些函数是「不让用户再面对 deepseek-chat 这类下线预填」的第一道防线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelsEndpoint, extractModels, MAX_MODELS } from './provider-models.logic.js';

test('extractModels：上下文窗口按多家键名解析；缺失/非法一律不带（前端退化成只报 tokens）', () => {
  const list = extractModels({
    data: [
      { id: 'a', context_window: 128000 },
      { id: 'b', context_length: '65536' },
      { id: 'c', max_context_tokens: 200000 },
      { id: 'd', max_context_window: 1000000 },
      { id: 'e', context_window: 0 },
      { id: 'f', context_window: -8 },
      { id: 'g', context_window: 'unknown' },
      { id: 'h' },
    ],
  });
  assert.deepEqual(
    list.map((m) => m.contextWindow ?? null),
    [128000, 65536, 200000, 1000000, null, null, null, null],
  );
});

test('modelsEndpoint：拼 /models、去尾斜杠、已含则幂等、http 本地地址可用', () => {
  assert.equal(modelsEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/models');
  assert.equal(modelsEndpoint('https://api.deepseek.com/v1///'), 'https://api.deepseek.com/v1/models');
  assert.equal(modelsEndpoint(' https://api.deepseek.com '), 'https://api.deepseek.com/models');
  assert.equal(modelsEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/models');
  assert.equal(modelsEndpoint('https://api.deepseek.com/v1/models'), 'https://api.deepseek.com/v1/models', '误填完整端点不 double');
});

test('modelsEndpoint：空值 / 非 http(s) / 垃圾串 → null（调用方回 400）', () => {
  assert.equal(modelsEndpoint(''), null);
  assert.equal(modelsEndpoint('   '), null);
  assert.equal(modelsEndpoint(null), null);
  assert.equal(modelsEndpoint(undefined), null);
  assert.equal(modelsEndpoint('ftp://x.com/v1'), null);
  assert.equal(modelsEndpoint('file:///etc/passwd'), null);
  assert.equal(modelsEndpoint('不是 URL'), null);
  assert.equal(modelsEndpoint('api.deepseek.com/v1'), null, '缺协议头不放行');
});

test('extractModels：OpenAI 标准形状 — id + name 展示名 + context_window，去重、跳过空 id', () => {
  const payload = {
    object: 'list',
    data: [
      // context_window 是真实服务商（DeepSeek）会返回的字段：顶栏「上下文使用率」的分母
      { id: 'deepseek-flash', object: 'model', name: 'DeepSeek V4.1 Flash', context_window: 1000000 },
      { id: 'deepseek-v4-pro', object: 'model', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-flash', object: 'model' }, // 重复 → 去重保序
      { name: 'no-id' }, // 无 id → 跳过
      { id: '   ' }, // 空白 → 跳过
    ],
  };
  assert.deepEqual(extractModels(payload), [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ]);
});

test('extractModels：models 形状（ollama 的 model 字段）与字符串数组', () => {
  assert.deepEqual(extractModels({ models: [{ name: 'Llama 3', model: 'llama3' }, { model: 'qwen2' }] }), [
    { id: 'llama3', name: 'Llama 3' },
    { id: 'qwen2' },
  ]);
  assert.deepEqual(extractModels(['a', 'b', 'a', '  ']), [{ id: 'a' }, { id: 'b' }]);
});

test('extractModels：name 等于 id 时不重复携带；上限截断', () => {
  assert.deepEqual(extractModels({ data: [{ id: 'x', name: 'x' }] }), [{ id: 'x' }]);
  const many = Array.from({ length: MAX_MODELS + 50 }, (_, i) => ({ id: 'm' + i }));
  const out = extractModels(many);
  assert.equal(out.length, MAX_MODELS);
  assert.equal(out[0].id, 'm0', '保序：不重排服务商顺序');
  assert.equal(out.at(-1).id, 'm' + (MAX_MODELS - 1));
});

test('extractModels：effort 元数据（supported_levels/default_level）随模型携带；坏形状丢弃', () => {
  const payload = {
    data: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
      { id: 'plain' },
      { id: 'bad', effort: { supported_levels: 'low', default_level: 'low' } }, // 档位非数组 → 整块丢
      { id: 'bad2', effort: { supported_levels: ['low'], default_level: 'xhigh' } }, // default 不在档位 → 只留档位
    ],
  };
  assert.deepEqual(extractModels(payload), [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    { id: 'plain' },
    { id: 'bad' },
    { id: 'bad2', efforts: ['low'] },
  ]);
});

test('extractModels：无法识别的形状 → null（调用方报「格式不符」）', () => {
  assert.equal(extractModels(null), null);
  assert.equal(extractModels({}), null);
  assert.equal(extractModels({ data: 'nope' }), null);
  assert.equal(extractModels('nope'), null);
  assert.deepEqual(extractModels({ data: [] }), [], '空列表是合法结果（前端提示未返回模型）');
});
