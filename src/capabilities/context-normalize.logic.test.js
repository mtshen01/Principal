/**
 * context-normalize 纯函数层单测（P0-③）：配对修复泛化（就近配对 + 脱档前拉 + 悬空合成）、
 * 孤立清理、剪空、中间截断与组合入口。原 run-openai.logic.test.js 的悬空修复用例在此延续。
 * 消息形状与 `providers/agent-loop.js#toToolResultMessage` / ai@7 `responseMessages` 保持一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipMiddle,
  normalizeSequence,
  pruneEmptyMessages,
  trimLargeParts,
  normalizeForModel,
  DEFAULT_MAX_ITEM_CHARS,
  DEFAULT_UNEXECUTED_NOTE,
} from './context-normalize.logic.js';

const user = (text) => ({ role: 'user', content: text });
const asst = (parts) => ({ role: 'assistant', content: parts });
const call = (id, name = 'readFile') => ({ type: 'tool-call', toolCallId: id, toolName: name, input: {} });
const result = (id, name = 'readFile', value = 'ok') => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'text', value } }],
});

// ---- clipMiddle ----

test('clipMiddle：短文本原样；超长保头 60%/尾 40% 且省略标记带准确字符数；非字符串不抛', () => {
  assert.equal(clipMiddle('abc', 10), 'abc');
  const long = 'x'.repeat(100);
  const clipped = clipMiddle(long, 40);
  assert.ok(clipped.startsWith('x'.repeat(24)), '头 60%');
  assert.ok(clipped.endsWith('x'.repeat(16)), '尾 40%');
  assert.match(clipped, /\n…（略 60 字符）…\n/, '省略标记 = 超出字符数');
  assert.equal(clipMiddle(null, 10), '');
  assert.equal(clipMiddle(12345, 10), '12345', '非字符串先强转再判上限');
});

// ---- normalizeSequence：合法序列 & 配对缺口（原 repairDanglingToolCalls 用例） ----

test('配对：合法序列原样返回（同一引用、零 stats 零 added）', () => {
  const msgs = [user('hi'), asst([call('t1')]), result('t1'), asst([{ type: 'text', text: 'done' }])];
  const r = normalizeSequence(msgs);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.stats, { synthesized: 0, droppedOrphans: 0, moved: 0 });
  assert.equal(r.messages, msgs);
});

test('配对：尾部悬空 tool-call → 补合成「未执行」结果（落盘用；原数组不动）', () => {
  const msgs = [user('read a'), asst([call('t1')])];
  const r = normalizeSequence(msgs);
  assert.equal(r.stats.synthesized, 1);
  assert.equal(r.messages.length, 3);
  assert.deepEqual(r.messages[2], {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 't1', toolName: 'readFile', output: { type: 'text', value: DEFAULT_UNEXECUTED_NOTE } },
    ],
  });
  assert.equal(r.added[0], r.messages[2], 'added 必须就是插进去的那条（供调用方落盘）');
  assert.equal(msgs.length, 2, '不得改动原数组');
});

test('配对：一条 assistant 多个调用只回了一个 → 只补缺的那个', () => {
  const msgs = [asst([call('t1'), call('t2', 'writeFile')]), result('t1')];
  const r = normalizeSequence(msgs);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].content[0].toolCallId, 't2');
});

test('配对：悬空调用后紧跟新 assistant（历史脏数据）→ 合成结果插在其前，消息序保持合法', () => {
  const second = asst([{ type: 'text', text: '我继续' }]);
  const msgs = [asst([call('t1')]), second];
  const r = normalizeSequence(msgs);
  assert.equal(r.added.length, 1);
  assert.equal(r.messages[1].role, 'tool');
  assert.equal(r.messages[1].content[0].toolCallId, 't1');
  assert.equal(r.messages[2], second, '原消息对象保持原序');
});

test('配对：悬空调用后紧跟 user 消息 → 合成结果插在其前（否则是非法序列）', () => {
  const userMsg = user('新指令');
  const msgs = [asst([call('t1')]), userMsg];
  const r = normalizeSequence(msgs);
  assert.equal(r.added.length, 1);
  assert.equal(r.messages[1].role, 'tool');
  assert.equal(r.messages[2], userMsg);
});

test('配对：无效调用已由 AI SDK 自带 error 结果 → 不重复补（error-text 也算配对）', () => {
  const auto = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'readFile', output: { type: 'error-text', value: 'invalid input' } }],
  };
  const r = normalizeSequence([asst([call('t1')]), auto]);
  assert.deepEqual(r.added, []);
  assert.equal(r.messages.length, 2);
});

test('配对：同一批多个结果乱序到达 → 全部保留（允许批内乱序，对齐真实工具执行序）', () => {
  const msgs = [asst([call('t1'), call('t2')]), result('t2'), result('t1')];
  const r = normalizeSequence(msgs);
  assert.deepEqual(r.stats, { synthesized: 0, droppedOrphans: 0, moved: 0 });
  assert.equal(r.messages, msgs);
});

test('配对：空数组 / 非数组入参不抛，原样返回', () => {
  assert.deepEqual(normalizeSequence([]).added, []);
  assert.deepEqual(normalizeSequence(null).added, []);
  assert.deepEqual(normalizeSequence(undefined).added, []);
});

// ---- normalizeSequence：孤立清理 ----

test('孤立：头部孤儿 tool 结果剔除（原 dropLeadingOrphans 能力迁移）；全是孤儿 → 空', () => {
  const msgs = [result('x'), result('y'), user('hi'), asst([{ type: 'text', text: 'ok' }])];
  const r = normalizeSequence(msgs);
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(r.stats.droppedOrphans, 2);
  assert.deepEqual(normalizeSequence([result('x')]).messages, []);
});

test('孤立：中部的孤儿 tool 结果同样剔除（原实现只管头部）', () => {
  const msgs = [user('hi'), result('ghost'), asst([{ type: 'text', text: 'ok' }])];
  const r = normalizeSequence(msgs);
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(r.stats.droppedOrphans, 1);
});

test('孤立：同一调用重复结果 → 只有第一个算配对，第二个剔除', () => {
  const msgs = [asst([call('t1')]), result('t1', 'readFile', 'first'), result('t1', 'readFile', 'dup')];
  const r = normalizeSequence(msgs);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[1].content[0].output.value, 'first');
  assert.equal(r.stats.droppedOrphans, 1);
});

test('孤立：混合 part 的 tool 消息 → 只剔孤儿 part，保留配对的；剔空则整条丢', () => {
  const mixed = {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 't1', toolName: 'readFile', output: { type: 'text', value: 'ok' } },
      { type: 'tool-result', toolCallId: 'ghost', toolName: 'readFile', output: { type: 'text', value: 'x' } },
    ],
  };
  const r = normalizeSequence([asst([call('t1')]), mixed]);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[1].content.length, 1);
  assert.equal(r.messages[1].content[0].toolCallId, 't1');
  assert.equal(r.stats.droppedOrphans, 1);
});

// ---- normalizeSequence：脱档前拉 ----

test('前拉：结果存在但隔了别的消息 → 把真实结果挪到调用后（不合成、不落盘），原位置消息消失', () => {
  const pulled = result('t1');
  const msgs = [user('读 a'), asst([call('t1')]), user('顺便看下 b'), pulled];
  const r = normalizeSequence(msgs);
  assert.equal(r.stats.moved, 1);
  assert.equal(r.stats.synthesized, 0);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(r.messages[2].content[0], pulled.content[0], '前拉的是原 result part（保真实结果）');
  assert.equal(r.messages[2].content[0].output.value, 'ok');
});

test('前拉：多 part 消息被前拉一部分 → 无关 part 按孤立剔除；前拉的是原 result part', () => {
  const mixed = {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 't1', toolName: 'readFile', output: { type: 'text', value: 'one' } },
      { type: 'tool-result', toolCallId: 't2', toolName: 'readFile', output: { type: 'text', value: 'two' } },
    ],
  };
  const msgs = [asst([call('t1')]), user('x'), mixed];
  const r = normalizeSequence(msgs);
  assert.deepEqual(r.messages.map((m) => m.role), ['assistant', 'tool', 'user']);
  assert.equal(r.messages[1].content[0], mixed.content[0], '前拉的 t1 part 是原对象');
  assert.equal(r.stats.moved, 1);
  assert.equal(r.stats.droppedOrphans, 1, 't2 无调用 → 孤立剔除');
});

test('前拉：被前拉的 part 不会在原消息里重复出现（同消息其余 part 按批配对）', () => {
  const mixed = {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: 'one' } }, // 会被前拉
      { type: 'tool-result', toolCallId: 't2', toolName: 'Read', output: { type: 'text', value: 'two' } }, // 配对 a2
    ],
  };
  const a2 = asst([call('t2')]);
  const msgs = [asst([call('t1')]), user('x'), a2, mixed];
  const r = normalizeSequence(msgs);
  assert.deepEqual(r.messages.map((m) => m.role), ['assistant', 'tool', 'user', 'assistant', 'tool']);
  assert.equal(r.messages[1].content[0].output.value, 'one', 't1 前拉到 a1 后');
  assert.equal(r.messages[4].content.length, 1, 'two 只有一份（不能既配对本批、又留在原消息）');
  assert.equal(r.messages[4].content[0].output.value, 'two');
  assert.equal(r.stats.moved, 1);
});

test('前拉：真实结果与合成不叠加——同一 id 只会产出恰好一条结果', () => {
  const msgs = [asst([call('t1')]), user('x'), result('t1'), result('t1', 'readFile', 'dup')];
  const r = normalizeForModel(msgs);
  const results = r.messages.filter((m) => m.role === 'tool');
  assert.equal(results.length, 1, '一条配对（前拉）');
  assert.equal(results[0].content[0].output.value, 'ok');
  assert.equal(r.stats.synthesized, 0);
  assert.equal(r.stats.droppedOrphans, 1, '重复结果剔除');
});

test('前拉/剔除的幂等：对 normalize 输出再跑一遍 → 原引用返回、零 stats', () => {
  const dirty = [result('a'), user('hi'), asst([call('t1')]), user('x'), result('t1'), asst([])];
  const first = normalizeForModel(dirty);
  const second = normalizeForModel(first.messages);
  assert.equal(second.messages, first.messages);
  assert.deepEqual(second.stats, { synthesized: 0, droppedOrphans: 0, moved: 0, droppedEmpty: 0, trimmed: 0 });
});

// ---- pruneEmptyMessages ----

test('剪空：空 assistant（[]/空串/无 content）与空 tool 剪除；空 user/system 保留；无变化原引用', () => {
  const a = { role: 'assistant', content: [] };
  const b = { role: 'assistant', content: '   ' };
  const c = { role: 'tool', content: null };
  const u = { role: 'user', content: '' };
  const s = { role: 'system', content: '' };
  const keep = asst([{ type: 'text', text: 'hi' }]);
  const r = pruneEmptyMessages([a, b, c, u, s, keep]);
  assert.deepEqual(r.messages, [u, s, keep]);
  assert.equal(r.dropped, 3);
  const same = [keep, u];
  assert.equal(pruneEmptyMessages(same).messages, same, '无变化原引用');
  assert.equal(pruneEmptyMessages(null).dropped, 0);
});

// ---- trimLargeParts ----

test('截断：超长 text part 中间截断（新对象，原消息不动）；短文本整块原引用返回', () => {
  const longPart = { type: 'text', text: 'y'.repeat(300) };
  const msg = asst([longPart, { type: 'text', text: 'short' }]);
  const short = asst([{ type: 'text', text: 'short' }]);
  const r = trimLargeParts([msg, short], { maxChars: 100 });
  assert.equal(r.trimmed, 1);
  assert.notEqual(r.messages[0], msg, '改了 part → 新消息对象');
  assert.equal(msg.content[0].text.length, 300, '原消息不动');
  assert.match(r.messages[0].content[0].text, /…（略 200 字符）…/);
  assert.equal(r.messages[1], short, '未超限的消息原引用');
  const none = trimLargeParts([short], { maxChars: 100 });
  assert.equal(none.messages[0], short);
  assert.equal(none.trimmed, 0);
});

test('截断：tool-result 的字符串负载（output 字符串 / value 字符串）截断，output type 保持', () => {
  const s = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'Read', output: { type: 'error-text', value: 'z'.repeat(200) } }] };
  const r = trimLargeParts([s], { maxChars: 80 });
  assert.equal(r.trimmed, 1);
  assert.equal(r.messages[0].content[0].output.type, 'error-text');
  assert.match(r.messages[0].content[0].output.value, /略 120 字符/);
  const raw = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'Read', output: 'q'.repeat(200) }] };
  const r2 = trimLargeParts([raw], { maxChars: 80 });
  assert.equal(r2.trimmed, 1);
  assert.match(r2.messages[0].content[0].output, /略 120 字符/);
});

test('截断：json 大对象序列化后降级 text/error-text；小对象不动；不可序列化不猜', () => {
  const big = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'MCP', output: { type: 'json', value: { blob: 'k'.repeat(500) } } }] };
  const r = trimLargeParts([big], { maxChars: 100 });
  assert.equal(r.trimmed, 1);
  assert.equal(r.messages[0].content[0].output.type, 'text', '截断后已非合法 JSON → 如实降级');
  assert.match(r.messages[0].content[0].output.value, /略 \d+ 字符/);
  const err = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'MCP', output: { type: 'error-json', value: { blob: 'k'.repeat(500) } } }] };
  assert.equal(trimLargeParts([err], { maxChars: 100 }).messages[0].content[0].output.type, 'error-text');
  const small = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'MCP', output: { type: 'json', value: { a: 1 } } }] };
  assert.equal(trimLargeParts([small], { maxChars: 100 }).trimmed, 0);
  const circular = {};
  circular.self = circular;
  const bad = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'MCP', output: { type: 'json', value: circular } }] };
  assert.equal(trimLargeParts([bad], { maxChars: 10 }).trimmed, 0, '序列化失败不猜、不抛');
});

test('截断：工具调用参数（tool-call input）不改；content 为字符串的消息可截；非法 maxChars = 不截', () => {
  const msg = asst([{ type: 'tool-call', toolCallId: 't', toolName: 'Write', input: { content: 'w'.repeat(500) } }]);
  assert.equal(trimLargeParts([msg], { maxChars: 50 }).trimmed, 0, '调用参数是历史事实，不动');
  const strMsg = { role: 'user', content: 'v'.repeat(300) };
  assert.equal(trimLargeParts([strMsg], { maxChars: 100 }).trimmed, 1);
  const a = [strMsg];
  assert.equal(trimLargeParts(a, { maxChars: Infinity }).messages, a, 'Infinity = 关闭截断');
  assert.equal(trimLargeParts(a, { maxChars: 0 }).messages, a);
  assert.equal(trimLargeParts(a, { maxChars: 'abc' }).messages, a);
  assert.equal(DEFAULT_MAX_ITEM_CHARS, 120_000);
});

// ---- normalizeForModel（组合入口） ----

test('组合：悬空 + 孤儿 + 空消息 + 超长一次结清；stats 齐全；原数组不动', () => {
  const longText = 'L'.repeat(2000);
  const msgs = [
    result('ghost'), // 头部孤儿
    user('干活'),
    asst([call('t1')]), // 悬空（下方有脱档结果，应前拉）
    { role: 'assistant', content: [] }, // 空消息
    user('继续'),
    result('t1'), // 脱档结果
    asst([{ type: 'text', text: longText }]), // 超长
  ];
  const snapshot = JSON.stringify(msgs);
  const r = normalizeForModel(msgs, { maxItemChars: 100 });
  assert.equal(JSON.stringify(msgs), snapshot, '输入不被改动');
  assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user', 'assistant']);
  assert.equal(r.messages[2].content[0].output.value, 'ok', '真实结果前拉');
  assert.match(r.messages[4].content[0].text, /略 1900 字符/);
  assert.deepEqual(r.stats, { synthesized: 0, droppedOrphans: 1, moved: 1, droppedEmpty: 1, trimmed: 1 });
  assert.deepEqual(r.added, []);
});

test('组合：真悬空（无任何结果）→ 合成进 added；stats.synthesized 计数正确', () => {
  const msgs = [user('跑一下'), asst([call('t1'), call('t2', 'Bash')]), result('t1')];
  const r = normalizeForModel(msgs);
  assert.equal(r.stats.synthesized, 1);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].content[0].toolCallId, 't2');
  assert.equal(r.messages[2].content[0].toolCallId, 't1');
  assert.equal(r.messages[3], r.added[0]);
});
