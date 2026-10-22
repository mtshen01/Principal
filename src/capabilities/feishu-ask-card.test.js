/**
 * feishu-ask-card.js 测试：卡片按钮 value 解析 + 回流处理器（注入 post，不触网络）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskCardValue, buildAskOptionHandler, FEISHU_ASK_CARD_KIND } from './feishu-ask-card.js';

const good = { action: { value: { kind: FEISHU_ASK_CARD_KIND, questionId: 'fq_1', option: 'user_id' } } };

test('parseAskCardValue：正常 value → {questionId, option}', () => {
  assert.deepEqual(parseAskCardValue(good), { questionId: 'fq_1', option: 'user_id' });
});

test('parseAskCardValue：value 是 JSON 字符串时也能解析（飞书有时字符串化）', () => {
  const data = { action: { value: JSON.stringify(good.action.value) } };
  assert.deepEqual(parseAskCardValue(data), { questionId: 'fq_1', option: 'user_id' });
});

test('parseAskCardValue：kind 不符 / 缺字段 / 非法 JSON → null', () => {
  assert.equal(parseAskCardValue({ action: { value: { kind: 'other', questionId: 'x', option: 'y' } } }), null);
  assert.equal(parseAskCardValue({ action: { value: { kind: FEISHU_ASK_CARD_KIND, questionId: 'fq_1' } } }), null, '缺 option');
  assert.equal(parseAskCardValue({ action: { value: '{bad json' } }), null);
  assert.equal(parseAskCardValue({}), null);
  assert.equal(parseAskCardValue(null), null);
});

test('buildAskOptionHandler：解析后交给 post；参数不全则不调用 post', async () => {
  const calls = [];
  const h = buildAskOptionHandler(async (parsed) => calls.push(parsed));
  await h(good);
  assert.deepEqual(calls, [{ questionId: 'fq_1', option: 'user_id' }]);

  await h({ action: { value: { kind: 'x' } } });
  assert.equal(calls.length, 1, '非法回调不应回流');
});
