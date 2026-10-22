/**
 * 左侧会话列表按天分组纯逻辑单测：自然日边界（非「距今 24h」）、月/年跨界、
 * 缺失时间戳归「更早」、空分组不返回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_GROUPS, dayGroupOf, groupConvsByDay } from './conv-groups.logic.js';

// 固定「现在」= 2026-10-10 15:00 本地时间，边界断言不依赖运行时钟
const NOW = new Date(2026, 9, 10, 15, 0, 0);
const at = (...args) => new Date(...args).getTime();

test('dayGroupOf：今天含 00:00 整点与未来时间（容忍时钟偏差）', () => {
  assert.equal(dayGroupOf(at(2026, 9, 10, 0, 0, 0, 0), NOW), 'today');
  assert.equal(dayGroupOf(at(2026, 9, 10, 14, 59, 59), NOW), 'today');
  assert.equal(dayGroupOf(at(2026, 9, 10, 23, 59, 59), NOW), 'today');
  assert.equal(dayGroupOf(at(2026, 9, 10, 16, 30, 0), NOW), 'today'); // 未来 1.5h
});

test('dayGroupOf：昨天覆盖 [昨天 00:00, 今天 00:00)，毫秒不越界', () => {
  assert.equal(dayGroupOf(at(2026, 9, 9, 0, 0, 0, 0), NOW), 'yesterday');
  assert.equal(dayGroupOf(at(2026, 9, 9, 23, 59, 59, 999), NOW), 'yesterday');
  // 今天 00:00 的前 1ms 仍属昨天
  assert.equal(dayGroupOf(at(2026, 9, 10, 0, 0, 0, 0) - 1, NOW), 'yesterday');
});

test('dayGroupOf：前天及更早归「更早」', () => {
  assert.equal(dayGroupOf(at(2026, 9, 8, 23, 59, 59), NOW), 'earlier');
  assert.equal(dayGroupOf(at(2026, 0, 1, 0, 0, 0), NOW), 'earlier');
});

test('dayGroupOf：缺失/非法时间戳归「更早」，不猜日期', () => {
  assert.equal(dayGroupOf(undefined, NOW), 'earlier');
  assert.equal(dayGroupOf(null, NOW), 'earlier');
  assert.equal(dayGroupOf(0, NOW), 'earlier');
  assert.equal(dayGroupOf(-1, NOW), 'earlier');
  assert.equal(dayGroupOf(NaN, NOW), 'earlier');
  assert.equal(dayGroupOf('abc', NOW), 'earlier');
});

test('dayGroupOf：跨月/跨年边界按自然日计算', () => {
  const novFirst = new Date(2026, 10, 1, 9, 0, 0); // 2026-11-01
  assert.equal(dayGroupOf(at(2026, 9, 31, 23, 0, 0), novFirst), 'yesterday'); // 10-31 → 昨天
  assert.equal(dayGroupOf(at(2026, 9, 30, 23, 0, 0), novFirst), 'earlier'); // 10-30 → 更早

  const newYear = new Date(2027, 0, 1, 9, 0, 0); // 2027-01-01
  assert.equal(dayGroupOf(at(2026, 11, 31, 23, 59, 59), newYear), 'yesterday'); // 12-31 → 昨天
});

test('DAY_GROUPS：固定三组顺序 今天 → 昨天 → 更早', () => {
  assert.deepEqual(DAY_GROUPS.map((g) => g.key), ['today', 'yesterday', 'earlier']);
  assert.deepEqual(DAY_GROUPS.map((g) => g.label), ['今天', '昨天', '更早']);
});

test('groupConvsByDay：只返回非空分组，组内保持传入顺序', () => {
  const entries = [
    { id: 'a', updatedAt: at(2026, 9, 10, 14, 0, 0) }, // 今天
    { id: 'b', updatedAt: at(2026, 9, 10, 9, 0, 0) }, // 今天（晚于 a 在列表中靠后）
    { id: 'c', updatedAt: at(2026, 9, 9, 18, 0, 0) }, // 昨天
    { id: 'd', updatedAt: at(2026, 8, 1, 10, 0, 0) }, // 更早
  ];
  const groups = groupConvsByDay(entries, NOW);
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'earlier']);
  assert.deepEqual(groups.map((g) => g.label), ['今天', '昨天', '更早']);
  assert.deepEqual(groups[0].items.map((e) => e.id), ['a', 'b']);
  assert.deepEqual(groups[1].items.map((e) => e.id), ['c']);
  assert.deepEqual(groups[2].items.map((e) => e.id), ['d']);
});

test('groupConvsByDay：空组被省略（昨天、更早无会话则不返回）', () => {
  const onlyToday = [{ id: 'x', updatedAt: at(2026, 9, 10, 8, 0, 0) }];
  const groups = groupConvsByDay(onlyToday, NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'today');
});

test('groupConvsByDay：空列表与非法入参返回空数组', () => {
  assert.deepEqual(groupConvsByDay([], NOW), []);
  assert.deepEqual(groupConvsByDay(null, NOW), []);
  assert.deepEqual(groupConvsByDay(undefined, NOW), []);
});
