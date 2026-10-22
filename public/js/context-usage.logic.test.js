/**
 * 顶栏「上下文使用率」纯逻辑单测：token 格式化、分档、以及最关键的
 * 「窗口未知时不许编百分比」——那个百分比会直接影响用户要不要新开会话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CTX_DANGER_PERCENT,
  CTX_WARN_PERCENT,
  formatTokens,
  contextLevel,
  contextUsageView,
} from './context-usage.logic.js';

test('formatTokens：千/万分界与 M 档；非法值归 0', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(12345), '12k');
  assert.equal(formatTokens(128000), '128k');
  assert.equal(formatTokens(1234567), '1.2M');
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens('abc'), '0');
  assert.equal(formatTokens(null), '0');
});

test('contextLevel：70/90 两档分界（与额度圆点同一套语义）', () => {
  assert.equal(contextLevel(0), 'normal');
  assert.equal(contextLevel(CTX_WARN_PERCENT - 1), 'normal');
  assert.equal(contextLevel(CTX_WARN_PERCENT), 'warning');
  assert.equal(contextLevel(CTX_DANGER_PERCENT - 1), 'warning');
  assert.equal(contextLevel(CTX_DANGER_PERCENT), 'danger');
  assert.equal(contextLevel(null), 'normal');
});

test('contextUsageView：窗口已知 → 百分比 + 剩余量', () => {
  const v = contextUsageView({ inputTokens: 32000, outputTokens: 800, contextWindow: 128000 });
  assert.equal(v.hidden, false);
  assert.equal(v.label, '上下文 25%');
  assert.equal(v.percent, 25);
  assert.equal(v.level, 'normal');
  assert.match(v.lines[0], /32k \/ 128k/);
  assert.match(v.lines[1], /输出 800/);
  assert.match(v.lines.at(-1), /剩余约 96k/);
});

test('contextUsageView：窗口未知 → 只报 tokens，percent 为 null（分母绝不猜）', () => {
  const v = contextUsageView({ inputTokens: 4200, contextWindow: 0 });
  assert.equal(v.hidden, false);
  assert.equal(v.percent, null);
  assert.equal(v.label, '上下文 4.2k');
  assert.match(v.lines[0], /未提供上下文窗口/);
  assert.ok(!v.lines.some((l) => /%/.test(l)), '不该出现任何百分比');
});

test('contextUsageView：70/90 分档与提示语；超窗单独一句', () => {
  const warn = contextUsageView({ inputTokens: 90000, contextWindow: 128000 });
  assert.equal(warn.level, 'warning');
  assert.match(warn.lines.at(-1), /剩余约 38k/);
  const danger = contextUsageView({ inputTokens: 120000, contextWindow: 128000 });
  assert.equal(danger.level, 'danger');
  assert.match(danger.lines.at(-1), /建议新开对话/);
  const over = contextUsageView({ inputTokens: 200000, contextWindow: 128000 });
  assert.equal(over.label, '上下文 156%');
  assert.match(over.lines.at(-1), /已超出窗口/);
});

test('contextUsageView：没有用量数据 → 整块隐藏（不在顶栏留空壳）', () => {
  assert.equal(contextUsageView({}).hidden, true);
  assert.equal(contextUsageView({ inputTokens: 0, contextWindow: 128000 }).hidden, true);
  assert.equal(contextUsageView().hidden, true);
  assert.equal(contextUsageView({ inputTokens: -1 }).hidden, true);
});

test('contextUsageView：非法输入不炸，按 0 处理', () => {
  const v = contextUsageView({ inputTokens: 'abc', outputTokens: null, contextWindow: 'x' });
  assert.equal(v.hidden, true);
  assert.equal(v.percent, null);
});
