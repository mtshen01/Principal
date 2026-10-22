/**
 * 上下文预算纯函数单测（P0）：估算口径（字节/4、多字节、part 各形态、图片固定估值）、
 * 阈值判定（窗口未知不判过线、90% 边界、摘要/预留计入）。
 * 估算是「什么时候压缩」的唯一依据，口径漂移会直接改变压缩行为——正反例都要钉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_PER_TOKEN,
  IMAGE_TOKEN_ESTIMATE,
  AUTO_COMPACT_RATIO,
  estimateTextTokens,
  estimateJsonTokens,
  estimatePartTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  contextTokenStatus,
} from './context-budget.logic.js';

test('estimateTextTokens：字节 ÷ 4 向上取整；非字符串/空串 → 0', () => {
  assert.equal(estimateTextTokens('a'.repeat(400)), 400 / BYTES_PER_TOKEN);
  assert.equal(estimateTextTokens('abcde'), Math.ceil(5 / 4), '非整除向上取整');
  // 中文 UTF-8 每字 3 字节：300 字节 → 75 token
  assert.equal(estimateTextTokens('中'.repeat(100)), 75, '按 UTF-8 字节而非 UTF-16 码元');
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens(null), 0);
  assert.equal(estimateTextTokens(123), 0);
});

test('estimateJsonTokens：对象序列化计数；字符串直测；不可序列化不抛', () => {
  assert.equal(estimateJsonTokens(null), 0);
  assert.equal(estimateJsonTokens('abcd'), 1);
  assert.equal(estimateJsonTokens({ a: 1 }), estimateTextTokens('{"a":1}'));
  const cyc = {};
  cyc.self = cyc;
  assert.equal(estimateJsonTokens(cyc), 0, '循环引用 → 0（不猜、不抛）');
});

test('estimatePartTokens：text/reasoning/tool-call/tool-result 各形态；未知类型与图片', () => {
  assert.equal(estimatePartTokens({ type: 'text', text: 'a'.repeat(40) }), 10);
  assert.equal(estimatePartTokens({ type: 'reasoning', text: 'a'.repeat(40) }), 10);
  assert.equal(estimatePartTokens({ type: 'image', image: 'data:...' }), IMAGE_TOKEN_ESTIMATE, '图片固定估值，不数 base64 原文');
  const call = { type: 'tool-call', toolName: 'Read', input: { file_path: '/tmp/a.txt' } };
  assert.equal(estimatePartTokens(call), estimateTextTokens('Read') + estimateTextTokens(JSON.stringify(call.input)));
  const result = { type: 'tool-result', output: { type: 'text', value: 'x'.repeat(80) } };
  assert.equal(estimatePartTokens(result), estimateTextTokens(JSON.stringify(result.output)));
  assert.equal(estimatePartTokens({ type: 'future-thing', data: 'x'.repeat(100) }), 0, '未知类型不猜');
  assert.equal(estimatePartTokens(null), 0);
});

test('estimateMessageTokens / estimateMessagesTokens：字符串与 part 数组两种 content', () => {
  assert.equal(estimateMessageTokens({ role: 'user', content: 'a'.repeat(40) }), 10);
  assert.equal(
    estimateMessageTokens({
      role: 'assistant',
      content: [{ type: 'text', text: 'a'.repeat(40) }, { type: 'tool-call', toolName: 'Bash', input: {} }],
    }),
    10 + estimateTextTokens('Bash') + estimateTextTokens('{}'),
  );
  assert.equal(estimateMessageTokens({ role: 'user' }), 0, '无 content → 0');
  assert.equal(estimateMessageTokens(null), 0);
  const msgs = [
    { role: 'user', content: 'a'.repeat(40) },
    { role: 'tool', content: [{ type: 'tool-result', output: 'b'.repeat(40) }] },
  ];
  assert.equal(estimateMessagesTokens(msgs), 20, '逐条累计（40B→10 + 40B→10）');
  assert.equal(estimateMessagesTokens(null), 0);
});

test('estimateMessageTokens：图片附件按固定估值计入（只认扩展名像图片的；非图片附件不计）', () => {
  const msg = {
    role: 'user',
    content: 'a'.repeat(40),
    attachments: [
      { path: 'C:/tmp/a.png', name: 'a.png' },
      { path: 'C:/tmp/b.JPEG', name: 'b.JPEG' },
      { path: 'C:/tmp/doc.pdf', name: 'doc.pdf' },
      { path: 'C:/tmp/noext', name: 'noext' },
    ],
  };
  assert.equal(estimateMessageTokens(msg), 10 + 2 * IMAGE_TOKEN_ESTIMATE, '两张图各计一份固定估值');
  assert.equal(
    estimateMessageTokens({ role: 'user', content: 'x', attachments: [{ path: 'C:/tmp/a.txt' }] }),
    estimateTextTokens('x'),
    '非图片附件不虚增',
  );
  assert.equal(estimateMessageTokens({ role: 'user', content: 'x', attachments: [] }), estimateTextTokens('x'));
});

test('contextTokenStatus：窗口未知 → 只报 tokens，绝不判过线（分母不猜）', () => {
  const s = contextTokenStatus({ messages: [{ role: 'user', content: 'a'.repeat(4000) }] });
  assert.equal(s.tokens, 1000);
  assert.equal(s.window, null);
  assert.equal(s.limit, null);
  assert.equal(s.usageRatio, null);
  assert.equal(s.over, false);
  assert.equal(contextTokenStatus({ windowTokens: 0 }).over, false, '窗口 0/负数/非法 = 未知');
  assert.equal(contextTokenStatus({ windowTokens: NaN }).over, false);
});

test('contextTokenStatus：90% 阈值边界；摘要与预留计入；可配比例', () => {
  const msg = (n) => ({ role: 'user', content: 'a'.repeat(n) });
  // 窗口 10000 → 阈值 9000；消息 8996 字节 → 2249 token，不过
  assert.equal(contextTokenStatus({ messages: [msg(8996)], windowTokens: 10000 }).over, false);
  // 9000 token 恰好达到阈值 → 触发（>=）
  assert.equal(contextTokenStatus({ messages: [msg(36000)], windowTokens: 10000 }).over, true);
  // 摘要文本计入
  const s = contextTokenStatus({ messages: [msg(36000 - 400)], summaryText: 'a'.repeat(400), windowTokens: 10000 });
  assert.equal(s.tokens, 9000);
  assert.equal(s.over, true);
  // extraTokens 预留计入
  assert.equal(contextTokenStatus({ messages: [msg(35000)], extraTokens: 250, windowTokens: 10000 }).over, true);
  // 自定义比例
  assert.equal(contextTokenStatus({ messages: [msg(20000)], windowTokens: 10000 }).over, false, '50% 不触发默认 90%');
  assert.equal(contextTokenStatus({ messages: [msg(20000)], windowTokens: 10000, ratio: 0.5 }).over, true);
  assert.equal(contextTokenStatus({ ratio: AUTO_COMPACT_RATIO }).over, false, '空输入不触发');
});
