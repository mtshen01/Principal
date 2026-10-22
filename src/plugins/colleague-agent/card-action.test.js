import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentUndoCard, UNDO_TIMEOUT_MS } from './card-action.js';
import { AGENT_UNDO_CARD_KIND } from '../../shared/agent-undo-card.js';

/** 造一条本 kind 的卡片回调报文 */
function cardData(over = {}) {
  return {
    action: { value: { kind: AGENT_UNDO_CARD_KIND, actionId: 'aa_1', ...(over.value || {}) } },
    operator: { open_id: over.operator ?? 'ou_owner' },
    context: { open_message_id: over.messageId ?? 'om_1' },
  };
}

/** 默认依赖：授权通过、撤销成功 */
function deps(over = {}) {
  const calls = { posts: [], updates: [] };
  return {
    calls,
    d: {
      updateCard: async (mid, card) => calls.updates.push({ mid, card }),
      postUndo: async (id) => {
        calls.posts.push(id);
        return { ok: true, note: null };
      },
      permOpts: () => ({ myOpenId: 'ou_owner', ownerOpenIds: [], trustedOpenIds: [] }),
      ...over,
    },
  };
}

test('非本 kind / 坏报文 → 完全静默（不撤销也不更新卡片）', async () => {
  const { calls, d } = deps();
  await handleAgentUndoCard(cardData({ value: { kind: '别的卡片' } }), d);
  await handleAgentUndoCard({ action: { value: '不是 JSON{' } }, d);
  await handleAgentUndoCard(null, d);
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.updates.length, 0);
});

test('非授权用户 → 不撤销，结果写回卡片', async () => {
  const { calls, d } = deps({ permOpts: () => ({ myOpenId: 'ou_host', ownerOpenIds: [], trustedOpenIds: [] }) });
  await handleAgentUndoCard(cardData({ operator: 'ou_随机路人' }), d);
  assert.equal(calls.posts.length, 0, '无权绝不发起撤销');
  assert.equal(calls.updates.length, 1);
  assert.match(calls.updates[0].card.elements[0].text.content, /仅主机\/可信提交人/);
});

test('授权用户 → 调 postUndo(actionId) + 成功回执卡', async () => {
  const { calls, d } = deps({ postUndo: async (id) => (calls.posts.push(id), { ok: true, note: '已连同排队中的地图更新一起撤销' }) });
  await handleAgentUndoCard(cardData({ value: { actionId: 'aa_777' } }), d);
  assert.deepEqual(calls.posts, ['aa_777']);
  assert.equal(calls.updates.length, 1);
  assert.match(calls.updates[0].card.elements[0].text.content, /已撤销/);
  assert.match(calls.updates[0].card.elements[0].text.content, /排队中的地图更新/);
});

test('撤销失败 → 失败原文写回卡片（不重试）', async () => {
  const { calls, d } = deps({ postUndo: async () => ({ ok: false, error: '这条改动已经撤销过了' }) });
  await handleAgentUndoCard(cardData(), d);
  assert.match(calls.updates[0].card.elements[0].text.content, /已经撤销过了/);
  assert.equal(calls.updates.length, 1, '只更新一次，不重试');
});

test('跨进程请求抛错（后端没起/超时）→ 失败卡且不冒泡', async () => {
  const { calls, d } = deps({ postUndo: async () => { throw new Error('fetch failed'); } });
  await assert.doesNotReject(handleAgentUndoCard(cardData(), d));
  assert.match(calls.updates[0].card.elements[0].text.content, /连接后端失败/);
});

test('无 messageId 时不更新卡片，但撤销照常发起', async () => {
  const { calls, d } = deps();
  await handleAgentUndoCard(cardData({ messageId: '' }), d);
  assert.deepEqual(calls.posts, ['aa_1']);
  assert.equal(calls.updates.length, 0);
});

test('真实 postUndo：POST 到 web 撤销路由，带 id 与 30s 超时', async () => {
  const fetched = [];
  const fakeFetch = async (url, opts) => {
    fetched.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, note: 'n' }) };
  };
  const { d } = deps({ postUndo: undefined, fetch: fakeFetch });
  // postUndoFn 传 null 走真实实现（deps.fetch 被透传）
  await handleAgentUndoCard(cardData(), { ...d, postUndo: null });
  assert.equal(fetched.length, 1);
  assert.match(fetched[0].url, /\/api\/req\/agent-action\/undo$/);
  assert.deepEqual(JSON.parse(fetched[0].opts.body), { id: 'aa_1' });
  assert.equal(UNDO_TIMEOUT_MS, 30_000);
});

test('真实 postUndo：web 回 409 + error → 透传成失败结果', async () => {
  const updates = [];
  await handleAgentUndoCard(cardData(), {
    postUndo: null,
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: '撤销执行出错：git 炸了' }) }),
    updateCard: async (mid, card) => updates.push({ mid, card }),
    permOpts: () => ({ myOpenId: 'ou_owner', ownerOpenIds: [], trustedOpenIds: [] }),
  });
  assert.match(updates[0].card.elements[0].text.content, /git 炸了/);
});
