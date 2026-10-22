/**
 * queue-strip.logic 单测：本地卡片 × 服务端清单的合并与「已投递」判定。
 * 口径：服务端 /api/run/queue 是唯一真相；本地项只在「早于本次拉取 + 服务端已无」时判为已投递。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeQueue } from './queue-strip.logic.js';

test('服务端为准：顺序/字段以服务端为准，mode 归一，文本缺时回落本地缓存', () => {
  const local = [{ id: 'fu_a', text: '甲（本地）', at: 100 }];
  const server = [
    { id: 'fu_b', text: '乙', mode: 'queue', at: 200 },
    { id: 'fu_a', text: '甲（服务端）', mode: 'steer', at: 100 },
  ];
  const { items, delivered } = mergeQueue(local, server, { fetchStartedAt: 1000 });
  assert.deepEqual(
    items.map((m) => [m.id, m.mode, m.text]),
    [
      ['fu_b', 'queue', '乙'],
      ['fu_a', 'steer', '甲（服务端）'],
    ],
  );
  assert.deepEqual(delivered, []);
});

test('本地有、服务端无且早于本次拉取 → 判已投递（离线期间被消费/排空）', () => {
  const local = [{ id: 'fu_old', text: '离线期间被投递', at: 100 }];
  const { items, delivered } = mergeQueue(local, [], { fetchStartedAt: 1000 });
  assert.deepEqual(items, []);
  assert.deepEqual(delivered.map((m) => m.id), ['fu_old']);
});

test('时间窗防误判：刚入队（at ≥ 拉取发起时刻）撞上陈旧响应 → 不判投递', () => {
  const local = [{ id: 'fu_new', text: '刚排的', at: 1500 }];
  const { items, delivered } = mergeQueue(local, [], { fetchStartedAt: 1200 });
  assert.deepEqual(items, []);
  assert.deepEqual(delivered, [], '新入队项不得被陈旧响应误判为上屏');
});

test('服务端缺文本时用本地缓存兜底；mode 缺省 queue', () => {
  const local = [{ id: 'fu_x', text: '本地文本', at: 1 }];
  const { items } = mergeQueue(local, [{ id: 'fu_x' }], { fetchStartedAt: 100 });
  assert.deepEqual(items, [{ id: 'fu_x', text: '本地文本', mode: 'queue', at: 1 }]);
});

test('空输入安全：undefined / 非数组 / 无 id 项不炸不产脏数据', () => {
  assert.deepEqual(mergeQueue(undefined, undefined, {}), { items: [], delivered: [] });
  const { items, delivered } = mergeQueue([null, { text: '无 id' }], [{ id: '' }], {});
  assert.deepEqual(items, []);
  assert.deepEqual(delivered, []);
});
