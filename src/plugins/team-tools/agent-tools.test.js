import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportBugTool, REPORT_BUG } from './agent-tools.js';

function make(extra = {}) {
  const calls = { created: [], queued: [] };
  const tool = buildReportBugTool({
    createTask: (t) => {
      calls.created.push(t);
      return { id: 't_new', title: t.title };
    },
    requestAutoDevelop: (...a) => calls.queued.push(a),
    ...extra,
  });
  return { tool, calls };
}

test('report_bug：定义形状（reversible + 全员可见 + buildUndo）', () => {
  const { tool } = make();
  assert.equal(tool.name, REPORT_BUG);
  assert.equal(tool.danger, 'reversible');
  assert.deepEqual(tool.roles, ['*']);
  assert.equal(typeof tool.buildUndo, 'function');
});

test('report_bug：空描述 → error，不建任务不入队', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ bug: '  ' }, { openId: 'ou_1' });
  assert.ok(out.error);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.queued.length, 0);
});

test('report_bug：成功 → 建 bug 任务 + 直入自动开发 + 回执带标题', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ bug: '订单列表点进去白屏，iOS 必现（v6.2.0）' }, { openId: 'ou_1', chatId: 'oc_1' });

  assert.equal(out.ok, true);
  assert.match(out.reply, /自动开发队列/);
  assert.match(out.reply, /订单列表点进去白屏/);

  assert.equal(calls.created.length, 1);
  const t = calls.created[0];
  assert.equal(t.type, 'bug');
  assert.equal(t.detail, '订单列表点进去白屏，iOS 必现（v6.2.0）');
  assert.equal(t.title.length <= 40, true);
  assert.deepEqual(t.source, { openId: 'ou_1', via: 'feishu', chatId: 'oc_1' });

  assert.deepEqual(calls.queued, [['t_new', '同事对话提交']], '直入自动开发（拍板 #1）');
});

test('report_bug：buildUndo 用 __private.taskId 产出 discard-task 锚点', async () => {
  const { tool } = make();
  const out = await tool.handler({ bug: '白屏' }, { openId: 'ou_1' });
  const undo = tool.buildUndo({ bug: '白屏' }, out, {});
  assert.deepEqual(undo, { kind: 'discard-task', taskId: 't_new' });
  // __private 的存在本身 OK（模型侧由 wrapper 剥掉）；这里钉的是 buildUndo 读得到
  assert.equal(out.__private.taskId, 't_new');
});

test('report_bug：建任务失败 → error，不入队', async () => {
  const { tool, calls } = make({ createTask: () => null });
  const out = await tool.handler({ bug: '白屏' }, { openId: 'ou_1' });
  assert.ok(out.error);
  assert.equal(calls.queued.length, 0);
});
