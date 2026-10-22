/**
 * 子代理句柄注册表运行时单测：注入假 `runTurn`（零真实模型），钉住
 * 阻塞/后台派发、续轮与邮箱、等待与超时、中断、并发闸、收尾与 journal 事件序列。
 *
 * 这些是「钱与可信度」问题：消息投了没执行（模型以为它做了）、中断没生效（白烧额度）、
 * 状态迁移写错（回放里看到的历史就是假的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRegistry } from './agent-registry.js';
import { AGENT_MAX_BACKGROUND, MAILBOX_MAX, WAIT_MIN_MS } from './agent-registry.logic.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 假执行体：每次调用造一个 deferred，由测试决定何时以什么结尾。
 * 语义对齐真 adapter：`aborted` 的轮返回 `{aborted:true}`（agent-loop 中断时就是这样返回的）。
 */
function makeRunner() {
  const calls = [];
  const runTurn = ({ agent, messages, text, signal }) => {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    const call = {
      agent,
      messages,
      text,
      signal,
      finish: (extra = {}) =>
        resolve({
          text: `结论：${text}`,
          history: [...messages.slice(0, -1), { role: 'user', content: text }, { role: 'assistant', content: `a:${text}` }],
          inputTokens: 10,
          outputTokens: 5,
          ...extra,
        }),
      fail: (message) => {
        const e = new Error(message);
        resolve(Promise.reject(e));
      },
    };
    // 真 adapter 收到 abort 会以 aborted 收流，这里如实模拟（否则 interrupt 的用例会假通过）
    signal?.addEventListener?.('abort', () => resolve({ text: '', aborted: true }), { once: true });
    calls.push(call);
    return promise;
  };
  return { runTurn, calls };
}

function makeRegistry(extra = {}) {
  const events = [];
  const lines = [];
  let pulses = 0;
  const runner = makeRunner();
  const reg = createAgentRegistry({
    runTurn: runner.runTurn,
    emit: (type, data) => events.push({ type, data }),
    activity: (line) => lines.push(line),
    pulse: () => {
      pulses += 1;
    },
    ...extra,
  });
  return { reg, runner, events, lines, pulses: () => pulses };
}

test('阻塞派发：await 拿到结论，状态与 journal 事件序列正确', async () => {
  const { reg, runner, events, lines } = makeRegistry();
  const p = reg.spawnBlocking({ label: '子代理', prompt: '查 A' });
  await tick();
  assert.equal(reg.snapshot().agents.a1.status, 'running');
  assert.equal(runner.calls[0].text, '查 A');
  assert.equal(runner.calls[0].agent.id, 'a1');
  runner.calls[0].finish();
  const out = await p;
  assert.deepEqual({ text: out.text, status: out.status }, { text: '结论：查 A', status: 'completed' });
  assert.equal(reg.snapshot().agents.a1.status, 'completed');
  assert.equal(reg.snapshot().agents.a1.turns, 1);
  assert.deepEqual(events.map((e) => e.data.status), ['pending', 'running', 'completed']);
  // journal 事件只带有界字段（结论全文不进 journal）
  assert.equal(events[2].data.summaryHead, '结论：查 A');
  assert.equal(events[2].data.agentId, 'a1');
  assert.equal(events[2].type, 'agent_status');
  assert.equal(lines.length, 0, '阻塞派发不额外写活动行（子代理自己的工具行由执行体转发）');
});

test('后台派发：立即返回 ack，wait 取结论，后台计数归还', async () => {
  const { reg, runner } = makeRegistry();
  const r = reg.spawnBackground({ label: '后台探望', prompt: '查 B' });
  assert.equal(r.ok, true);
  assert.match(r.text, /已后台派发子代理 a1/);
  assert.equal(reg.stats().backgroundActive, 1);
  await tick();
  assert.equal(reg.list()[0].status, 'running');
  assert.match(await reg.executeTool('list_agents', {}), /本轮子代理（1 个）/);
  const waiting = reg.wait('a1', { timeoutMs: 5000 });
  runner.calls[0].finish();
  const w = await waiting;
  assert.equal(w.timedOut, false);
  assert.match(await reg.executeTool('wait_agent', { agent_id: 'a1' }), /结论：查 B/);
  assert.equal(reg.stats().backgroundActive, 0);
});

test('命中名字（而非 id）也能寻址', async () => {
  const { reg, runner } = makeRegistry();
  reg.spawnBackground({ label: '支付 模块/审查', prompt: '查' });
  const name = reg.list()[0].name;
  assert.equal(name, '/root/支付-模块-审查-1');
  await tick();
  runner.calls[0].finish();
  await tick();
  assert.match(await reg.executeTool('wait_agent', { agent_id: name }), /结论：查/);
});

test('wait 超时：如实返回「仍在运行」并在等待期间打心跳，不一直挂住', async () => {
  const { reg, pulses } = makeRegistry();
  reg.spawnBackground({ label: '慢', prompt: '查' });
  await tick();
  // 两条路径并行等（都是 1s 上限）：直调 wait + 工具面 wait_agent（超时分支的文案是给人看的）
  const [r, text] = await Promise.all([
    reg.wait('a1', { timeoutMs: WAIT_MIN_MS }),
    reg.executeTool('wait_agent', { agent_id: 'a1', timeout_ms: WAIT_MIN_MS }),
  ]);
  assert.equal(r.timedOut, true);
  assert.equal(r.agent.status, 'running');
  assert.ok(pulses() >= 1, '等待期间必须打心跳（否则看门狗把正常等待当卡死）');
  assert.match(text, /仍在运行/);
  assert.match(text, /list_agents/);
  reg.interruptAll();
});

test('send 到空闲的子代理 → 起新一轮：历史接续、turns 递增、usage 累计', async () => {
  const { reg, runner } = makeRegistry();
  const p = reg.spawnBlocking({ label: '子代理', prompt: '查 A' });
  await tick();
  runner.calls[0].finish();
  await p;
  const sent = reg.send('a1', '再查 B');
  assert.equal(sent.mode, 'started');
  assert.match(sent.text, /起第 2 轮/);
  await tick();
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.calls[1].messages, [
    { role: 'user', content: '查 A' },
    { role: 'assistant', content: 'a:查 A' },
    { role: 'user', content: '再查 B' },
  ]);
  runner.calls[1].finish();
  await tick();
  const rec = reg.snapshot().agents.a1;
  assert.equal(rec.turns, 2);
  assert.equal(rec.status, 'completed');
  assert.deepEqual(rec.usage, { inputTokens: 20, outputTokens: 10 });
});

test('send 到运行中的子代理 → 入邮箱，当前轮结束后自动接续（消息不会静默丢掉）', async () => {
  const { reg, runner } = makeRegistry();
  reg.spawnBackground({ label: '子代理', prompt: '查 A' });
  await tick();
  const r = reg.send('a1', '补充：也要看 B');
  assert.equal(r.mode, 'queued');
  assert.match(r.text, /自动接续/);
  runner.calls[0].finish();
  await tick();
  assert.equal(runner.calls.length, 2, '本轮结束后必须自动接续一轮');
  assert.equal(runner.calls[1].text, '补充：也要看 B');
  runner.calls[1].finish();
  await tick();
  assert.match(reg.get('a1').summary, /结论：补充：也要看 B/);
});

test('邮箱积压多条 → 合并成一轮（不把同一份上下文重复喂给模型）', async () => {
  const { reg, runner } = makeRegistry();
  reg.spawnBackground({ label: '子代理', prompt: '查 A' });
  await tick();
  reg.send('a1', '第一点');
  reg.send('a1', '第二点');
  runner.calls[0].finish();
  await tick();
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[1].text, '第一点\n\n第二点');
  runner.calls[1].finish();
  await tick();
});

test('邮箱满 → 明确拒绝；wait 收一轮后又能继续发', async () => {
  const { reg, runner } = makeRegistry();
  reg.spawnBackground({ label: '子代理', prompt: '查 A' });
  await tick();
  for (let i = 0; i < MAILBOX_MAX; i++) assert.equal(reg.send('a1', `第 ${i} 条`).ok, true);
  const full = reg.send('a1', '溢出');
  assert.equal(full.ok, false);
  assert.match(full.text, new RegExp(`邮箱已满（${MAILBOX_MAX} 条未消费）`));
  runner.calls[0].finish();
  await tick();
  runner.calls[1]?.finish();
  await tick();
});

test('中断运行中的子代理：该轮以 interrupted 落定，wait 立即返回并能看到半截结论', async () => {
  const { reg, runner, events } = makeRegistry();
  reg.spawnBackground({ label: '跑偏了', prompt: '查' });
  await tick();
  const r = reg.interrupt('a1');
  assert.equal(r.changed, true);
  await tick();
  assert.equal(reg.snapshot().agents.a1.status, 'interrupted');
  assert.equal(events.at(-1).data.status, 'interrupted');
  const text = await reg.executeTool('wait_agent', { agent_id: 'a1' });
  assert.match(text, /已被中断/);
  // 被中断的 agent 仍在句柄表里、历史保留 → 可以带着它继续
  runner.calls[0].finish({ text: '（其实已经查到了 X）' });
  await tick();
  assert.equal(reg.get('a1').status, 'interrupted', '中断后迟到的收尾不改回 completed');
});

test('中断空闲的子代理：如实回「没有在跑」，不改状态', async () => {
  const { reg, runner } = makeRegistry();
  const p = reg.spawnBlocking({ label: '子代理', prompt: '查' });
  await tick();
  runner.calls[0].finish();
  await p;
  const r = reg.interrupt('a1');
  assert.equal(r.changed, false);
  assert.match(r.text, /没有在跑/);
  assert.equal(reg.get('a1').status, 'completed');
});

test('失败：状态 errored + 错误进 journal（有界），wait 如实回失败', async () => {
  const { reg, runner, events } = makeRegistry();
  const p = reg.spawnBlocking({ label: '子代理', prompt: '查' });
  await tick();
  runner.calls[0].fail('上游 500');
  const out = await p;
  assert.equal(out.status, 'errored');
  assert.equal(reg.snapshot().agents.a1.error, '上游 500');
  assert.equal(events.at(-1).data.status, 'errored');
  assert.match(await reg.executeTool('wait_agent', { agent_id: 'a1' }), /执行失败：上游 500/);
});

test('后台并发闸：第 5 个后台发起被拒；阻塞式不受影响', async () => {
  const { reg, runner } = makeRegistry();
  for (let i = 0; i < AGENT_MAX_BACKGROUND - 1; i++) {
    assert.equal(reg.spawnBackground({ label: `并发${i}`, prompt: '查' }).ok, true);
  }
  // 先跑完一个阻塞式（a4，idle 待用），再把后台占满
  const p = reg.spawnBlocking({ label: '阻塞', prompt: '查' });
  await tick();
  runner.calls.at(-1).finish();
  await p;
  assert.equal(reg.spawnBackground({ label: '第四个后台', prompt: '查' }).ok, true);
  assert.equal(reg.stats().backgroundActive, AGENT_MAX_BACKGROUND);
  const denied = reg.spawnBackground({ label: '第五个', prompt: '查' });
  assert.equal(denied.ok, false);
  assert.match(denied.text, /后台子代理已达上限（4 个在跑）/);
  // 空闲 agent 起新一轮也算后台发起 → 同样受闸
  assert.match(reg.send('a4', '再来').text, /后台子代理已达上限/);
  // 阻塞式照常可跑（父模型自己在等，并发由编排自身上限约束）
  const p2 = reg.spawnBlocking({ label: '阻塞二', prompt: '查' });
  await tick();
  runner.calls.at(-1).finish();
  assert.equal((await p2).status, 'completed');
  reg.interruptAll();
});

test('settleAll：等得住的等，超时的 abort 并如实报条数 + 活动行', async () => {
  const { reg, runner, lines } = makeRegistry();
  reg.spawnBackground({ label: 'A', prompt: '查 A' });
  reg.spawnBackground({ label: 'B', prompt: '查 B' });
  await tick();
  runner.calls[0].finish();
  const out = await reg.settleAll({ timeoutMs: 20 });
  assert.equal(out.aborted, 1);
  assert.equal(reg.get('a1').status, 'completed');
  assert.equal(reg.get('a2').status, 'interrupted');
  assert.match(lines.at(-1), /1 个后台子代理超过 0s 仍未收尾/);
});

test('settleAll：没有在跑的就不等（零成本）', async () => {
  const { reg } = makeRegistry();
  assert.deepEqual(await reg.settleAll(), { aborted: 0, waited: 0 });
});

test('interruptAll：幂等，两次调用第二次为 0', async () => {
  const { reg } = makeRegistry();
  reg.spawnBackground({ label: 'A', prompt: '查' });
  reg.spawnBackground({ label: 'B', prompt: '查' });
  await tick();
  assert.equal(reg.interruptAll().count, 2);
  await tick();
  assert.equal(reg.interruptAll().count, 0);
});

test('未知子代理 / 空消息：四个工具都给可读文案，绝不抛', async () => {
  const { reg } = makeRegistry();
  assert.match(await reg.executeTool('send_message', { agent_id: 'a9', message: 'x' }), /未知子代理：a9/);
  assert.match(await reg.executeTool('wait_agent', { agent_id: 'a9' }), /未知子代理：a9/);
  assert.match(await reg.executeTool('interrupt_agent', { agent_id: 'a9' }), /未知子代理：a9/);
  assert.match(await reg.executeTool('list_agents', {}), /还没有派过子代理/);
  reg.spawnBackground({ label: 'A', prompt: '查' });
  await tick();
  assert.match(await reg.executeTool('send_message', { agent_id: 'a1', message: '   ' }), /message 不能为空/);
  assert.match(await reg.executeTool('send_message', { agent_id: 'a1' }), /message 不能为空/);
  assert.equal(reg.spawnBackground({ label: 'x', prompt: '' }).ok, false);
  reg.interruptAll();
});

test('空 prompt 的阻塞派发：不注册句柄，直接回「未产出结论」', async () => {
  const { reg } = makeRegistry();
  assert.deepEqual(await reg.spawnBlocking({ label: 'x', prompt: '' }), { text: '（子代理未产出结论）', status: 'errored' });
  assert.equal(reg.stats().total, 0);
});

test('createAgentRegistry 缺 runTurn 直接抛（装配错误不留到运行时）', () => {
  assert.throws(() => createAgentRegistry({}), /需要注入 runTurn/);
});

test('emit 抛错不影响 agent 驱动（journal 落盘失败不能拖垮 run）', async () => {
  const runner = makeRunner();
  const reg = createAgentRegistry({
    runTurn: runner.runTurn,
    emit: () => {
      throw new Error('磁盘满');
    },
  });
  const p = reg.spawnBlocking({ label: '子代理', prompt: '查' });
  await tick();
  runner.calls[0].finish();
  assert.equal((await p).status, 'completed');
});
