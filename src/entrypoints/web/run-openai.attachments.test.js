/**
 * 图片附件端到端接线（2026-10-15）：`startOpenAiRun` 把 attachments 元数据落进检查点、provider
 * input 带上 `prepareMessages`（模型边界的视图变换）。真跑 agent-loop + 真内置工具，只把最外层
 * 模型调用换成脚本；provider 同 id 覆盖（registry 支持的测试替身范式）。
 *
 * 本文件钉的是**接线**而不是内联算法（算法在 capabilities/image-attachments.logic.test.js）：
 *  1. 落盘只存 {path,name} 元数据，绝不存 base64（conv-messages.json 会无限膨胀）；
 *  2. provider 真能拿到 prepareMessages，且它对消息的变换结果能被模型侧消费（file part）；
 *  3. 视图变换不写回检查点（落盘消息仍是纯文本）；
 *  4. fail-open：图片不存在/超大只报告，run 照常完成。
 *
 * 隔离：APP_DATA_DIR 指向临时目录；全部动态 import（store 基座在模块求值时定死目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'run-openai-attach-'));
process.env.APP_DATA_DIR = DATA;

const providers = await import('../../providers/index.js');
const { runAgentLoop } = await import('../../providers/agent-loop.js');
const { startOpenAiRun } = await import('./run-openai.js');
const { getMessages, clearMessages } = await import('../../store/conv-messages.js');
const { createRun } = await import('../../store/runs.js');
const { setBuiltinMcp, setRepoMapEnabled, addToken } = await import('../../store/settings.js');

let scriptedModel = null;
let lastInput = null;
providers.register({
  id: 'openai-compat',
  capabilities: {},
  run(input, hooks) {
    lastInput = input;
    const done = runAgentLoop(
      { messages: input.messages, modelRun: scriptedModel, executeTool: input.executeTool, signal: input.abortController?.signal },
      hooks,
    );
    return { done, abort: () => {} };
  },
});

/** 最小可用 PNG：魔数 8 字节 + 填充（内联只看魔数，不需要真解码） */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x11),
]);

const oneStep = (text) => () => ({
  stream: (async function* () {
    yield { type: 'text', text };
  })(),
  finished: Promise.resolve({
    finishReason: 'stop',
    toolCalls: [],
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
  }),
});

async function waitDone(run, ms = 3000) {
  const t0 = Date.now();
  while (run.status === 'running' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(run.status, 'running', 'run 应在时限内收尾');
}

let CRED_ID = null;
test.before(() => {
  // 关掉外部依赖：内置 MCP（会拉 npx 子进程）与仓库地图（会扫盘）
  setBuiltinMcp('context7', { enabled: false });
  setRepoMapEnabled(false);
  const tokens = addToken('测试模型', 'sk-test', 'openai-compat', { baseURL: 'http://127.0.0.1:9/v1', model: 'test-model' });
  CRED_ID = tokens[tokens.length - 1].id;
});

test('start：附件元数据落检查点（无 base64）；prepareMessages 内联出 file part 且不写回', async () => {
  const convId = 'c_attach';
  clearMessages(convId);
  const imgPath = path.join(DATA, 'shot.png');
  fs.writeFileSync(imgPath, PNG);
  scriptedModel = oneStep('看到了，是一张测试图');

  const run = createRun();
  await startOpenAiRun(run, {
    prompt: `这张图里是什么？${imgPath}`,
    model: 'test-model',
    credId: CRED_ID,
    cwd: DATA,
    convId,
    attachments: [{ path: imgPath, name: 'shot.png' }, { path: imgPath, name: '同路径重复' }, '   '],
  });
  await waitDone(run);
  assert.equal(run.status, 'done');

  const msgs = getMessages(convId);
  const user = msgs.find((m) => m.role === 'user');
  assert.equal(typeof user.content, 'string', '落盘的是纯文本 + 元数据（不存 base64）');
  assert.deepEqual(user.attachments, [{ path: imgPath, name: 'shot.png' }], '同路径去重、空项剔除');
  assert.ok(!JSON.stringify(msgs).includes('base64'), '检查点里不得出现 base64');

  assert.equal(typeof lastInput.prepareMessages, 'function', 'provider input 必须带 prepareMessages');
  const view = await lastInput.prepareMessages(msgs);
  const viewUser = view.find((m) => m.role === 'user');
  assert.ok(Array.isArray(viewUser.content), '视图里 user content 变为 part 数组');
  const textPart = viewUser.content.find((p) => p.type === 'text');
  const filePart = viewUser.content.find((p) => p.type === 'file');
  assert.ok(textPart && textPart.text.includes('这张图里是什么'), '原文本保留');
  assert.ok(filePart, '图片附件内联成 file part');
  assert.equal(filePart.mediaType, 'image/png');
  assert.ok(Buffer.isBuffer(filePart.data) && filePart.data.equals(PNG), 'file part 携带原始字节');
  assert.ok(!('attachments' in viewUser), '模型视图剥掉元数据');
  assert.ok(
    run.activities.some((a) => a.includes('图片已随消息发给模型')),
    '活动转录给一次性回执（用户能确认图片确实发出去了）',
  );

  const after = getMessages(convId).find((m) => m.role === 'user');
  assert.equal(typeof after.content, 'string', '视图变换不写回检查点');
  assert.ok(Array.isArray(after.attachments), '元数据仍在（下一步/续跑继续内联）');
});

test('start：图片不存在 → 只报告不阻塞（fail-open，run 照常完成）', async () => {
  const convId = 'c_attach_missing';
  clearMessages(convId);
  scriptedModel = oneStep('按路径处理吧');
  const missing = path.join(DATA, 'nope.png');

  const run = createRun();
  await startOpenAiRun(run, {
    prompt: `它长什么样？${missing}`,
    model: 'test-model',
    credId: CRED_ID,
    cwd: DATA,
    convId,
    attachments: [{ path: missing, name: 'nope.png' }],
  });
  await waitDone(run);
  assert.equal(run.status, 'done', '图片读不到不能阻塞 run');

  const view = await lastInput.prepareMessages(getMessages(convId));
  const user = view.find((m) => m.role === 'user');
  assert.equal(typeof user.content, 'string', '读不到就退回纯文本路径');
  assert.ok(
    run.activities.some((a) => a.includes('图片未随消息发送')),
    '回执里说明原因（不是静默丢弃）',
  );
});
