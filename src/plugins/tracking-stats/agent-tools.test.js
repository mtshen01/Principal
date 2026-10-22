import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackingReportTool, TRACKING_REPORT } from './agent-tools.js';

function make(extra = {}) {
  const calls = { start: [], sent: [] };
  const tool = buildTrackingReportTool({
    startFreeformQuery: async (a) => {
      calls.start.push(a);
      return { started: true };
    },
    sendText: async (target, text) => calls.sent.push({ target, text }),
    ...extra,
  });
  return { tool, calls };
}

test('tracking_report：定义形状（safe 档 + 仅 ops/product 可见）', () => {
  const { tool } = make();
  assert.equal(tool.name, TRACKING_REPORT);
  assert.equal(tool.danger, 'safe');
  assert.deepEqual(tool.roles.slice().sort(), ['ops', 'product']);
});

test('tracking_report：缺 openId → error，不启动分析', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ question: '上周新增' }, { colleagueId: 'cl_1' });
  assert.ok(out.error);
  assert.equal(calls.start.length, 0);
});

test('tracking_report：空问题 → error', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ question: '   ' }, { openId: 'ou_1' });
  assert.ok(out.error);
  assert.equal(calls.start.length, 0);
});

test('tracking_report：成功 → 异步 kick-off（ack:false、reply 直发同事、userId=openId），立即返回', async () => {
  const { tool, calls } = make();
  const out = await tool.handler({ question: '上周新增用户里有多少下单了' }, { openId: 'ou_1', colleagueId: 'cl_1', chatId: 'oc_1', chatType: 'p2p' });

  assert.equal(out.started, true);
  assert.match(out.note, /直接发/);
  assert.equal(calls.start.length, 1);
  const a = calls.start[0];
  assert.equal(a.text, '上周新增用户里有多少下单了');
  assert.equal(a.userId, 'ou_1', '限流与审计口径与老路径同键（openId）');
  assert.equal(a.chatId, 'oc_1');
  assert.equal(a.ack, false, 'agent 自己会先回执，后台不再重复「收到」');

  // reply 适配器直发同事（私聊来源：目标是 openId）
  await a.reply('结论文本');
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].target.kind, 'p2p');
  assert.equal(calls.sent[0].target.receiveId, 'ou_1');
  assert.equal(calls.sent[0].text, '结论文本');
});

// 2026-10-13：结果送达与主回复同一条路由 —— 群里问的，几分钟后的结论也要回群里并 @ 提问人
test('tracking_report：群聊来源 → 结果回群里并 @ 提问人（与主回复同一份路由判定）', async () => {
  const { tool, calls } = make();
  await tool.handler(
    { question: '上周新增' },
    { openId: 'ou_1', colleagueId: 'cl_1', chatId: 'oc_g', chatType: 'group' },
  );
  const a = calls.start[0];
  await a.reply('结论文本');
  assert.equal(calls.sent[0].target.kind, 'group');
  assert.equal(calls.sent[0].target.receiveId, 'oc_g');
  assert.equal(calls.sent[0].target.at, '<at user_id="ou_1"></at> ');
});

test('tracking_report：限流 → started:false 转成 error 文案（模型如实转述）', async () => {
  const { tool } = make({ startFreeformQuery: async () => ({ started: false, error: '查得有点密，稍等一下再试' }) });
  const out = await tool.handler({ question: 'x' }, { openId: 'ou_1' });
  assert.equal(out.error, '查得有点密，稍等一下再试');
  assert.equal(out.started, undefined);
});
