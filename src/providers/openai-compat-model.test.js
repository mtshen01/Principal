import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { streamTextToModelRun } from './openai-compat-model.js';
import { inlineImageAttachments } from '../capabilities/image-attachments.logic.js';

test('streamTextToModelRun：把 streamText 文本流映射成规范化 {type:text} + finished', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'Hello ' },
          { type: 'text-delta', id: '1', delta: 'world' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
        ],
      }),
    }),
  });
  const modelRun = streamTextToModelRun(model);
  const { stream, finished } = await modelRun([{ role: 'user', content: 'hi' }]);
  const parts = [];
  for await (const ev of stream) parts.push(ev);
  assert.deepEqual(parts, [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }]);
  const done = await finished;
  assert.equal(typeof done.finishReason, 'string');
  assert.ok(Array.isArray(done.responseMessages));
  assert.ok(Array.isArray(done.toolCalls));
});

test('streamTextToModelRun：fullStream 的 error part → stream 抛出', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'partial' },
          { type: 'error', error: new Error('provider exploded') },
        ],
      }),
    }),
  });
  const { stream } = await streamTextToModelRun(model)([{ role: 'user', content: 'hi' }]);
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } }, /provider exploded/);
});

test('streamTextToModelRun：reasoning-delta 透传为心跳（agent-loop 空闲判死据此不误杀长思考）', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: '思考中…' },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'ok' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
      }),
    }),
  });
  const { stream, finished } = await streamTextToModelRun(model)([{ role: 'user', content: 'hi' }]);
  const parts = [];
  for await (const ev of stream) parts.push(ev);
  assert.deepEqual(parts, [{ type: 'reasoning', text: '思考中…' }, { type: 'text', text: 'ok' }]);
  await finished;
});

// ── 工具调用映射 + 校验结论（2026-09-30 按 ai@7 实测补）──────────────────
// 实测事实：finishReason 是对象形态 { unified, raw }；zod 形态的 inputSchema 会被 AI SDK
// 校验，不匹配时调用带 invalid:true，且 responseMessages 里自动补一条 error 结果。

test('工具调用映射：合法调用 input 为对象；unified finishReason 透传到 finished', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: JSON.stringify({ path: 'a.txt' }) },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
  const tools = { Read: { description: 'r', inputSchema: z.object({ path: z.string() }) } };
  const { stream, finished } = await streamTextToModelRun(model, tools)([{ role: 'user', content: 'hi' }]);
  const parts = [];
  for await (const p of stream) parts.push(p);
  assert.deepEqual(parts, [
    { type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: { path: 'a.txt' }, invalid: false },
  ]);
  const done = await finished;
  assert.equal(done.finishReason, 'tool-calls');
  assert.equal(done.toolCalls.length, 1);
});

test('工具调用映射：schema 不匹配 → invalid=true + errorText；AI SDK 已自带 error 结果', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'tool-call', toolCallId: 't2', toolName: 'Read', input: JSON.stringify({ path: 123 }) },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
  const tools = { Read: { description: 'r', inputSchema: z.object({ path: z.string() }) } };
  const { stream, finished } = await streamTextToModelRun(model, tools)([{ role: 'user', content: 'hi' }]);
  const parts = [];
  for await (const p of stream) parts.push(p);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].invalid, true);
  assert.match(parts[0].errorText, /Invalid input|Type validation failed/);
  const done = await finished;
  assert.equal(done.toolCalls[0].invalid, true);
  const toolMsg = done.responseMessages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'AI SDK 应为无效调用自动生成 error 结果（loop 不得再追加第二条）');
});

// ── system 消息拆分（ai@7 硬约束回归）──────────────────────────
// 2026-10-08 P3 真端点冒烟实锤：生产路径（run-openai 的 modelMessages）把 system 放在 messages
// 首条，ai@7 的 streamText 直接抛 InvalidPromptError（「System messages are not allowed...
// Use the instructions option instead」）——真实模型调用必失败，此前单测用 mock 且从未带 system 形态而漏网。
test('system 消息：拆到 instructions，不触发 InvalidPromptError，且确实到达模型', async () => {
  let seenPromptRoles = null;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seenPromptRoles = (options.prompt || []).map((m) => m.role);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ok' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      };
    },
  });
  const { stream, finished } = await streamTextToModelRun(model)([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: 'hi' },
  ]);
  const parts = [];
  for await (const p of stream) parts.push(p);
  assert.deepEqual(parts, [{ type: 'text', text: 'ok' }]);
  await finished;
  assert.deepEqual(seenPromptRoles, ['system', 'user'], 'instructions 必须真的进了模型提示词');
});

// ── prepareMessages（模型边界视图变换：图片附件内联回归，2026-10-15）──────────
// 生产接线：run-openai 注入 prepareMessages → 把消息上显式 attachments 里的图片读成 file part
//（openai-compatible provider 再映射成 image_url 的 data URL）。这里捕获**真实到达模型**的
// 提示词，钉死三件事：异步 prepare 被 await；file part 形态正确（不是被丢掉的未知 part）；
// 它是视图变换——agent-loop 持有的原消息（含 attachments 元数据）不被改写。
test('prepareMessages：图片附件内联成 file part 到达模型；原消息不被改写', async () => {
  let seenPrompt = null;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seenPrompt = options.prompt;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ok' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ],
        }),
      };
    },
  });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8, 1),
  ]);
  const origin = [{ role: 'user', content: '这张图里是什么', attachments: [{ path: 'C:/tmp/a.png', name: 'a.png' }] }];
  const prepareMessages = async (msgs) => (await inlineImageAttachments(msgs, { readFile: async () => png })).messages;
  const { stream, finished } = await streamTextToModelRun(model, undefined, undefined, undefined, prepareMessages)(origin);
  for await (const _ of stream) {
    /* drain */
  }
  await finished;
  const userPrompt = (seenPrompt || []).filter((m) => m.role === 'user');
  assert.equal(userPrompt.length, 1);
  const filePart = userPrompt[0].content.find((p) => p.type === 'file');
  assert.ok(filePart, 'file part 必须到达模型提示词（被吞掉就说明形态不对）');
  assert.equal(filePart.mediaType, 'image/png');
  assert.equal(userPrompt[0].content.find((p) => p.type === 'text').text, '这张图里是什么');
  assert.equal(origin[0].content, '这张图里是什么', '视图变换不得改写原消息');
  assert.deepEqual(origin[0].attachments, [{ path: 'C:/tmp/a.png', name: 'a.png' }], 'attachments 元数据仍在原消息上（落盘/压缩用）');
});
