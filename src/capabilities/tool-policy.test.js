/**
 * 工具策略运行时门单测（T6）：无人值守翻译/计次熔断/别名/回调容错 + 直调 runClaude 的选项拼装。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createPolicyGate, buildUnattendedClaudeOpts, buildClaudePretoolHook, MAX_POLICY_BLOCKS } from './tool-policy.js';

const WS = path.resolve('bench-ws-test');
const INSIDE = path.join(WS, 'a.txt');

test('交互路径：allow/ask/deny 透传；deny 只记 onDeny（count=0），绝不熔断', () => {
  const denies = [];
  let fused = 0;
  const gate = createPolicyGate({
    level: 'default',
    workspace: WS,
    onDeny: (i) => denies.push(i),
    onFuse: () => fused++,
  });
  assert.equal(gate.decide('Read', { file_path: INSIDE }).action, 'allow');
  assert.equal(gate.decide('Write', { file_path: INSIDE }).action, 'ask');
  for (let i = 0; i < 5; i++) assert.equal(gate.decide('Bash', { command: 'rm -rf /' }).action, 'deny');
  assert.equal(denies.length, 5, '每次策略拒绝都记 onDeny');
  assert.ok(denies.every((i) => i.count === 0), '交互路径不计数');
  assert.equal(fused, 0);
  assert.equal(gate.blocks(), 0);
});

test('无人值守：ask 翻译为 deny 并计次；第 3 次 onFuse 恰一次；后续拒绝不重复熔断', () => {
  const denies = [];
  let fused = 0;
  const gate = createPolicyGate({
    level: 'unattended-standard',
    unattended: true,
    workspace: WS,
    maxBlocks: MAX_POLICY_BLOCKS,
    onDeny: (i) => denies.push(i),
    onFuse: () => fused++,
  });

  const d1 = gate.decide('Bash', { command: 'git push origin main' }); // ask → deny
  assert.equal(d1.action, 'deny');
  assert.match(d1.reason, /无人值守/);

  assert.equal(gate.decide('Bash', { command: 'npm test' }).action, 'allow', '安全命令放行且不计数');
  assert.equal(gate.decide('Write', { file_path: INSIDE }).action, 'allow', '区内写放行');

  gate.decide('Bash', { command: 'rm -rf /' }); // 危险命令 deny（也计数）
  gate.decide('Bash', { command: 'curl https://x' }); // 第 3 次 → 熔断
  assert.equal(gate.blocks(), 3);
  assert.equal(fused, 1, 'onFuse 恰一次');

  gate.decide('Bash', { command: 'curl https://y' });
  assert.equal(fused, 1, '熔断后再拒绝不重复触发');
  assert.equal(denies.at(-1).count, 4);
});

test('disabledTools 经别名归一：MultiEdit 与 Edit 共用开关', () => {
  const gate = createPolicyGate({
    level: 'acceptEdits',
    workspace: WS,
    disabledTools: new Set(['Edit']),
    alias: { MultiEdit: 'Edit' },
  });
  assert.equal(gate.decide('MultiEdit', { file_path: INSIDE }).action, 'deny');
  assert.equal(gate.decide('Edit', { file_path: INSIDE }).action, 'deny');
  assert.equal(gate.decide('Write', { file_path: INSIDE }).action, 'allow', '未禁用的写工具不受影响');
});

test('level 支持函数（读运行时档位，如 run.mode 中途放宽）', () => {
  let lvl = 'default';
  const gate = createPolicyGate({ level: () => lvl, workspace: WS });
  assert.equal(gate.decide('Write', { file_path: INSIDE }).action, 'ask');
  lvl = 'acceptEdits';
  assert.equal(gate.decide('Write', { file_path: INSIDE }).action, 'allow');
});

test('回调异常被吞：onDeny 抛错不影响裁决结果', () => {
  const gate = createPolicyGate({
    level: 'default',
    workspace: WS,
    onDeny: () => {
      throw new Error('boom');
    },
  });
  assert.equal(gate.decide('Bash', { command: 'rm -rf /' }).action, 'deny');
});

test('buildUnattendedClaudeOpts：bypass 档不装 canUseTool，但 deny 名单由钩子兜底（不再真空）', async () => {
  const opts = buildUnattendedClaudeOpts({ execPolicy: undefined, workspace: WS });
  assert.equal(opts.permissionMode, 'bypassPermissions');
  assert.equal(opts.canUseTool, undefined, 'bypass 仍不装 canUseTool（审批面与改动前一致）');
  const hook = opts.hooks.PreToolUse[0].hooks[0];
  const denied = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny', '灾难性命令必须被钩子拦下');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /安全策略/);
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), {}, '例行命令不表态（旁路放行）');
  assert.equal(opts.policy.execPolicy, 'bypass');
});

test('buildClaudePretoolHook：default 恒 ask / bypass 只拦 deny 名单 / 其余不表态，档位动态读取', async () => {
  let lvl = 'default';
  const hooks = buildClaudePretoolHook({ levelOf: () => lvl, workspace: WS });
  const hook = hooks.PreToolUse[0].hooks[0];

  const ask = await hook({ tool_name: 'Write', tool_input: { file_path: INSIDE } });
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask', 'default：裁决权交回 canUseTool');

  lvl = 'acceptEdits';
  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: { file_path: INSIDE } }), {}, 'acceptEdits：不表态，维持 SDK 原语义');

  lvl = 'bypassPermissions';
  const denied = await hook({ tool_name: 'Bash', tool_input: { command: 'taskkill /f /im node.exe' } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny', 'bypass：灾难性命令仍被拦');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /批量结束本机进程/);
  assert.deepEqual(
    await hook({ tool_name: 'Write', tool_input: { file_path: path.resolve('C:/outside/x.txt') } }),
    {},
    'bypass：越界写不拦（审批面语义不变，only deny 名单设防）',
  );

  lvl = 'default';
  const askAgain = await hook({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(askAgain.hookSpecificOutput.permissionDecision, 'ask', '切回 default 恢复 ask');
});

test('buildUnattendedClaudeOpts：standard 档按表裁决；连续 3 次拒绝 → 中断 + 通知恰一次', async () => {
  const aborted = [];
  const notified = [];
  const fused = [];
  const opts = buildUnattendedClaudeOpts({
    execPolicy: 'standard',
    workspace: WS,
    abortController: { abort: () => aborted.push(1) },
    label: '测试任务',
    notify: (title, message) => notified.push({ title, message }),
    onFuse: (info) => fused.push(info.count),
  });
  assert.equal(opts.permissionMode, 'default', 'standard 必须走 default 让 canUseTool 生效');
  assert.ok(opts.hooks?.PreToolUse, 'PreToolUse 强制每次调用都过策略门');
  assert.equal(opts.policy.policyLevel, 'unattended-standard');

  assert.equal((await opts.canUseTool('Bash', { command: 'npm test' })).behavior, 'allow');
  assert.equal((await opts.canUseTool('Write', { file_path: INSIDE })).behavior, 'allow');

  const d = await opts.canUseTool('Bash', { command: 'git push origin main' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /无人值守/);

  await opts.canUseTool('Bash', { command: 'curl https://x' });
  await opts.canUseTool('Bash', { command: 'curl https://y' });
  assert.deepEqual(fused, [3], 'onFuse 恰一次、在第 3 次');
  assert.equal(aborted.length, 1, '熔断必须中断本轮');
  assert.equal(notified.length, 1);
  assert.match(notified[0].message, /测试任务/);
});
