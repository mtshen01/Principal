/**
 * follow-up 队列落盘（P1-9）单测：三迁移往返 / 幂等 / no-op 不写盘 / 损坏即抛 / 清理。
 * 隔离：APP_DATA_DIR → 临时目录；动态 import（store 基座在模块求值时定死数据目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-followups-'));
process.env.APP_DATA_DIR = DATA;

const { applyFollowUpOp, readAllFollowUps, clearAllFollowUps } = await import('./conv-followups.js');

const file = () => path.join(DATA, 'conv-followups.json');
const item = (id, text) => ({ id, at: 123, text, source: 'web', provider: 'openai-compat', model: 'glm', credId: 'cred_1' });

test.beforeEach(() => clearAllFollowUps());

test('三迁移：enqueue 追加 / cancel 移除 / take 清键；空键自动删除', () => {
  assert.deepEqual(readAllFollowUps(), {});
  assert.equal(applyFollowUpOp({ type: 'enqueue', convId: 'c1', item: item('fu_1', '第一句') }).changed, true);
  assert.equal(applyFollowUpOp({ type: 'enqueue', convId: 'c1', item: item('fu_2', '第二句') }).changed, true);
  assert.equal(applyFollowUpOp({ type: 'enqueue', convId: 'c2', item: item('fu_3', '别的会话') }).changed, true);

  let all = readAllFollowUps();
  assert.deepEqual(all.c1.map((m) => m.text), ['第一句', '第二句']);
  assert.deepEqual(all.c2.map((m) => m.text), ['别的会话']);
  assert.equal(all.c1[0].provider, 'openai-compat', '起跑快照原样落盘');

  assert.equal(applyFollowUpOp({ type: 'cancel', convId: 'c1', id: 'fu_1' }).changed, true);
  all = readAllFollowUps();
  assert.deepEqual(all.c1.map((m) => m.id), ['fu_2']);

  assert.equal(applyFollowUpOp({ type: 'cancel', convId: 'c1', id: 'fu_2' }).changed, true);
  all = readAllFollowUps();
  assert.equal(all.c1, undefined, '最后一条被撤回 → 键删除');

  assert.equal(applyFollowUpOp({ type: 'take', convId: 'c2' }).changed, true);
  assert.deepEqual(readAllFollowUps(), {}, 'take 清掉该 conv');
});

test('幂等与 no-op：重复 enqueue 同 id 不改盘；cancel/take/未知 op 对不存在项不写盘', () => {
  applyFollowUpOp({ type: 'enqueue', convId: 'c1', item: item('fu_1', '原句') });
  const before = fs.readFileSync(file(), 'utf8');
  assert.equal(applyFollowUpOp({ type: 'enqueue', convId: 'c1', item: item('fu_1', '重复投递') }).changed, false);
  assert.equal(fs.readFileSync(file(), 'utf8'), before, '重复投递不写盘');
  assert.equal(applyFollowUpOp({ type: 'cancel', convId: 'c1', id: 'fu_ghost' }).changed, false);
  assert.equal(applyFollowUpOp({ type: 'take', convId: 'c_ghost' }).changed, false);
  assert.equal(applyFollowUpOp({ type: 'weird', convId: 'c1' }).changed, false);
  assert.equal(applyFollowUpOp({ type: 'enqueue' }).changed, false, '缺 convId 不受理');
  assert.equal(fs.readFileSync(file(), 'utf8'), before, 'no-op 全部不写盘');
  assert.deepEqual(readAllFollowUps().c1.map((m) => m.text), ['原句']);
});

test('损坏即抛（store 惯例）：读与写都不得把损坏文件当空处理', () => {
  fs.writeFileSync(file(), '{broken');
  assert.throws(() => readAllFollowUps(), /已损坏|解析失败/);
  assert.throws(() => applyFollowUpOp({ type: 'enqueue', convId: 'c1', item: item('fu_x', 'x') }), /已损坏|解析失败/);
  fs.writeFileSync(file(), JSON.stringify({ v: 1, convs: {} })); // 复原，避免影响后续用例
});

test('clearAllFollowUps：清空可重复', () => {
  applyFollowUpOp({ type: 'enqueue', convId: 'c1', item: item('fu_1', 'x') });
  clearAllFollowUps();
  assert.deepEqual(readAllFollowUps(), {});
  clearAllFollowUps();
  assert.deepEqual(readAllFollowUps(), {});
});
