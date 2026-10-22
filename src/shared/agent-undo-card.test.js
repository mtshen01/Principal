import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_UNDO_CARD_KIND,
  buildAgentUndoCard,
  buildAgentUndoResultCard,
  parseAgentUndoCardAction,
} from './agent-undo-card.js';

test('buildAgentUndoCard：三种结局各自的头部文案 + 分支行', () => {
  const merged = buildAgentUndoCard({ actionId: 'aa_1', colleagueName: '张三', reqTitle: '订单改版', branch: 'req/r/agent-m1', baseBranch: 'feat/order', outcome: 'merged' });
  const mergedText = merged.elements[0].text.content;
  assert.match(mergedText, /已完成并合并/);
  assert.match(mergedText, /张三/);
  assert.match(mergedText, /订单改版/);
  assert.match(mergedText, /req\/r\/agent-m1 → feat\/order/);
  assert.match(mergedText, /反向提交/, '已合并的撤销语义要写清');

  const pending = buildAgentUndoCard({ actionId: 'aa_2', outcome: 'pending-merge', branch: 'b', baseBranch: 'main' });
  assert.match(pending.elements[0].text.content, /待合并/);
  assert.match(pending.elements[0].text.content, /删除该分支/);

  const failed = buildAgentUndoCard({ actionId: 'aa_3', outcome: 'merge-failed' });
  assert.match(failed.elements[0].text.content, /合并失败/);
});

test('buildAgentUndoCard：按钮 value 带 kind 与 actionId（无内存态路由锚点）', () => {
  const card = buildAgentUndoCard({ actionId: 'aa_9', outcome: 'merged' });
  const action = card.elements.find((e) => e.tag === 'action');
  assert.equal(action.actions.length, 1);
  assert.deepEqual(action.actions[0].value, { kind: AGENT_UNDO_CARD_KIND, actionId: 'aa_9' });
  assert.equal(action.actions[0].type, 'danger');
});

test('buildAgentUndoCard：缺分支/需求时不拼误导性空行', () => {
  const card = buildAgentUndoCard({ actionId: 'aa_x', outcome: 'merged' });
  assert.doesNotMatch(card.elements[0].text.content, /\n分支：/, '没有真实分支时不拼「分支：x → null」');
  assert.doesNotMatch(card.elements[0].text.content, /null/);
});

test('buildAgentUndoResultCard：成功附 note；失败带原文并说明不会标记已撤销', () => {
  const ok = buildAgentUndoResultCard({ ok: true, note: '已连同排队中的地图更新一起撤销' });
  assert.match(ok.elements[0].text.content, /已撤销/);
  assert.match(ok.elements[0].text.content, /排队中的地图更新/);

  const bad = buildAgentUndoResultCard({ ok: false, error: '撤销执行出错：git 炸了' });
  assert.match(bad.elements[0].text.content, /撤销失败/);
  assert.match(bad.elements[0].text.content, /git 炸了/);
  assert.match(bad.elements[0].text.content, /不会标记为已撤销/);
});

test('parseAgentUndoCardAction：对象与 JSON 字符串两种 value 形态都认', () => {
  const data = {
    action: { value: { kind: AGENT_UNDO_CARD_KIND, actionId: 'aa_5' } },
    operator: { open_id: 'ou_host' },
    context: { open_message_id: 'om_1' },
  };
  assert.deepEqual(parseAgentUndoCardAction(data), { actionId: 'aa_5', operatorOpenId: 'ou_host', messageId: 'om_1' });

  const asString = { action: { value: JSON.stringify({ kind: AGENT_UNDO_CARD_KIND, actionId: 'aa_6' }) } };
  assert.equal(parseAgentUndoCardAction(asString).actionId, 'aa_6');
});

test('parseAgentUndoCardAction：坏输入一律 null，不炸', () => {
  assert.equal(parseAgentUndoCardAction(null), null);
  assert.equal(parseAgentUndoCardAction({ action: { value: null } }), null);
  assert.equal(parseAgentUndoCardAction({ action: { value: '不是 JSON{' } }), null);
  assert.equal(parseAgentUndoCardAction({ action: { value: { kind: '别的卡片', actionId: 'aa' } } }), null);
  assert.equal(parseAgentUndoCardAction({ action: { value: { kind: AGENT_UNDO_CARD_KIND } } }), null, '缺 actionId');
  assert.equal(parseAgentUndoCardAction({ action: { value: { kind: AGENT_UNDO_CARD_KIND, actionId: '' } } }), null);
});
