/**
 * run 回放 reducer 单测（P1-12，spec 2026-10-11-request-snapshot-and-run-replay-design.md）。
 * 覆盖：全事件类型映射、状态口径（settled/unsettled/unknown）、runId 过滤与坏数据容忍、
 * 格式化关键行、CLI 子进程冒烟（--data-dir 私有目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reduceRunTimeline, formatRunTimeline } from './run-replay.logic.js';

const ev = (type, d, seq, at, extra = {}) => ({ v: 1, seq, runId: 'run_t', convId: 'c_t', at, type, data: d, ...extra });

function fullEvents() {
  return [
    ev('submitted', { provider: 'openai-compat', requestId: 'rq_1', cwd: 'C:/w', model: 'm-1', effort: 'low', ultracode: false, mode: 'default', session: null, resumeAttempt: 0 }, 1, 1000),
    ev('started', { pid: 4242 }, 2, 1001),
    ev('usage', { step: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110, model: 'm-1', contextWindow: 1000 }, 3, 1010),
    ev('compaction', { reason: 'tokens', tokensBefore: 2000, tokensAfter: 500, window: 1000, limit: 900, visibleBefore: 220, coveredBefore: 0, coveredAfter: 120, kept: 100, summaryChars: 40, model: 'm-1' }, 4, 1015),
    ev('model_retry', { retry: 1, max: 5, delayMs: 2000, kind: 'network', error: 'fetch failed' }, 5, 1020),
    ev('steer', { msgId: 'hm_1', text: '改一下' }, 6, 1030),
    ev('steer_withdrawn', { msgId: 'hm_1' }, 7, 1031),
    ev('steer', { msgId: 'hm_2', text: '继续' }, 8, 1032),
    ev('steer_consumed', { msgIds: ['hm_2'], via: 'flush' }, 9, 1040),
    ev('follow_up', { id: 'fu_1', text: '稍后跑测试', source: 'web' }, 10, 1050),
    ev('follow_up_cancelled', { id: 'fu_1' }, 11, 1051),
    ev('ask', { reqId: 'rq_a', kind: 'permission', title: 'Write' }, 12, 1060),
    ev('decision', { reqId: 'rq_a', choice: 'allow', via: 'set_mode' }, 13, 1061),
    ev('policy_block', { tool: 'Bash', klass: 'exec', ruleId: 'deny-rm', reason: '危险', count: 2 }, 14, 1062),
    ev('usage', { step: 2, inputTokens: 150, outputTokens: 20, totalTokens: 170, model: 'm-1', contextWindow: 1000 }, 15, 1065),
    ev('agent_status', { agentId: 'a1', name: '/root/探查-1', provider: 'openai-subagent', role: 'explorer', status: 'running', turns: 1, ms: 0, inputTokens: 0, outputTokens: 0, summaryHead: '', error: null }, 16, 1068),
    ev('agent_status', { agentId: 'a1', name: '/root/探查-1', provider: 'openai-subagent', role: 'explorer', status: 'completed', turns: 1, ms: 900, inputTokens: 400, outputTokens: 60, summaryHead: '查到了三处调用', error: null }, 17, 1069),
    ev('result', { subtype: 'success', isError: false, inputTokens: 250, outputTokens: 30 }, 18, 1070),
    ev('settled', { status: 'done', subtype: 'success', attempts: null }, 19, 1080),
  ];
}

test('归约：全事件类型 → 时间线字段', () => {
  const t = reduceRunTimeline(fullEvents());
  assert.equal(t.runId, 'run_t');
  assert.equal(t.convId, 'c_t');
  assert.equal(t.status, 'done');
  assert.equal(t.submittedAt, 1000);
  assert.equal(t.endedAt, 1080);
  assert.equal(t.durationMs, 80);
  assert.equal(t.firstSeq, 1);
  assert.equal(t.lastSeq, 19);
  assert.equal(t.eventCount, 19);
  assert.deepEqual(t.meta, {
    provider: 'openai-compat', model: 'm-1', effort: 'low', mode: 'default',
    ultracode: false, cwd: 'C:/w', requestId: 'rq_1', resumeAttempt: 0,
  });
  assert.equal(t.startedPid, 4242);
  assert.deepEqual(t.tokens[0], { at: 1010, step: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110, model: 'm-1', contextWindow: 1000 });
  assert.equal(t.tokens.length, 2);
  assert.equal(t.compactions.length, 1);
  assert.equal(t.compactions[0].coveredAfter, 120);
  assert.equal(t.retries.length, 1);
  assert.equal(t.retries[0].kind, 'network');
  assert.deepEqual(t.steer.held.map((x) => x.msgId), ['hm_1', 'hm_2']);
  assert.deepEqual(t.steer.withdrawn.map((x) => x.msgId), ['hm_1']);
  assert.deepEqual(t.steer.consumed[0].msgIds, ['hm_2']);
  assert.deepEqual(t.followUps.queued.map((x) => x.id), ['fu_1']);
  assert.deepEqual(t.followUps.cancelled.map((x) => x.id), ['fu_1']);
  assert.equal(t.asks.length, 1);
  assert.equal(t.decisions[0].choice, 'allow');
  assert.equal(t.policyBlocks[0].count, 2);
  // 子代理句柄（P1-7）：状态迁移逐条平铺（聚合归 reduceAgentEvents，回放要的是时刻）
  assert.deepEqual(t.agents.map((a) => a.status), ['running', 'completed']);
  assert.deepEqual(t.agents[1], {
    at: 1069, agentId: 'a1', name: '/root/探查-1', role: 'explorer', provider: 'openai-subagent',
    status: 'completed', turns: 1, ms: 900, tokens: 460, summaryHead: '查到了三处调用', error: null,
  });
  assert.equal(t.results[0].subtype, 'success');
  assert.deepEqual(t.settled, { at: 1080, status: 'done', subtype: 'success', attempts: null });
  assert.deepEqual(t.unknownTypes, []);
});

test('状态口径与容忍：无 settled → unsettled；空 → unknown；runId 过滤；坏数据/未知类型不炸', () => {
  const noSettled = reduceRunTimeline([ev('submitted', {}, 1, 5)]);
  assert.equal(noSettled.status, 'unsettled');
  assert.equal(noSettled.durationMs, null);

  const empty = reduceRunTimeline([]);
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.runId, null);

  const mixed = reduceRunTimeline([
    ev('submitted', {}, 1, 1),
    ev('submitted', {}, 1, 1, { runId: 'other' }),
    { type: 'weird', data: null, seq: 2, runId: 'run_t' },
    null,
    { runId: 'run_t' },
  ]);
  assert.equal(mixed.runId, 'run_t');
  assert.equal(mixed.eventCount, 3);
  assert.deepEqual(mixed.unknownTypes.sort(), ['(missing)', 'weird']);
});

test('格式化：关键行齐备；空时间线返回占位', () => {
  const text = formatRunTimeline(reduceRunTimeline(fullEvents())).join('\n');
  assert.match(text, /\[run_t\] openai-compat m-1 effort=low mode=default → done/);
  assert.match(text, /submitted .* cwd=C:\/w requestId=rq_1/);
  assert.match(text, /tokens step=1 in=100 out=10 total=110 window=1000/);
  assert.match(text, /compact tokens 2000→500 tokens kept=100 covered=120/);
  assert.match(text, /retry #1\/5 network 2000ms：fetch failed/);
  assert.match(text, /steer\+ hm_1：「改一下」/);
  assert.match(text, /steer- hm_1/);
  assert.match(text, /steer→ hm_2（flush）/);
  assert.match(text, /follow-up\+ fu_1：「稍后跑测试」/);
  assert.match(text, /ask rq_a permission Write/);
  assert.match(text, /decision rq_a → allow（set_mode）/);
  assert.match(text, /blocked Bash（exec\/deny-rm）×2/);
  assert.match(text, /agent a1 \/root\/探查-1 → running 第1轮/);
  assert.match(text, /agent a1 \/root\/探查-1 → completed 第1轮 0\.9s 460 tokens：查到了三处调用/);
  assert.match(text, /settled done\/success/);
  assert.deepEqual(formatRunTimeline(null), ['(无事件)']);
  assert.deepEqual(formatRunTimeline(reduceRunTimeline([])), ['(无事件)']);
});

test('CLI：--data-dir + --run-id 打印时间线；--json 输出全量', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'run-journal.jsonl'), fullEvents().map((e) => JSON.stringify(e)).join('\n') + '\n');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'replay-run.mjs');
  const out = execFileSync(process.execPath, [script, '--run-id', 'run_t', '--data-dir', dir], { encoding: 'utf8' });
  assert.match(out, /\[run_t\] openai-compat m-1/);
  assert.match(out, /settled done\/success/);
  const parsed = JSON.parse(execFileSync(process.execPath, [script, '--run-id', 'run_t', '--data-dir', dir, '--json'], { encoding: 'utf8' }));
  assert.equal(parsed.status, 'done');
  assert.equal(parsed.eventCount, 19);
});
