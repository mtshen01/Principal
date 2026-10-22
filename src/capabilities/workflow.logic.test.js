/**
 * 自定义模型 Ultracode 编排的纯逻辑单测：入参归一边界（截断而非报错）、
 * 逐阶段并发的确定性（顺序/并发度/失败不中断/abort）、回传主模型的汇总裁剪。
 * 钉这些是因为编排直接决定额度开销：阶段数写飞、并发失控、失败被吞都是钱与可信度问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_MAX_PHASES,
  WORKFLOW_MAX_TASKS,
  WORKFLOW_MAX_TASKS_PER_PHASE,
  WORKFLOW_TOOL_DEF,
  buildUltracodeAuthPrompt,
  mergeWorkflowResults,
  normalizeWorkflowSpec,
  runWorkflowPlan,
  workflowLabel,
} from './workflow.logic.js';

const spec = (phases) => ({ name: '审查', goal: '查清楚', phases });
const task = (prompt, title) => ({ ...(title ? { title } : {}), prompt });

test('normalizeWorkflowSpec：正常形状 → 阶段/子任务/计数', () => {
  const { plan } = normalizeWorkflowSpec(
    spec([
      { title: '并行调研', tasks: [task('查 A', 'A'), task('查 B')] },
      { title: '交叉验证', tasks: [task('验 A')] },
    ]),
  );
  assert.equal(plan.name, '审查');
  assert.equal(plan.goal, '查清楚');
  assert.equal(plan.phases.length, 2);
  assert.equal(plan.taskCount, 3);
  assert.deepEqual(plan.phases[0].tasks.map((t) => t.title), ['A', '子任务 2']);
  assert.equal(plan.phases[0].title, '并行调研');
});

test('normalizeWorkflowSpec：宽松取字段（steps/agents/task/字符串项），空白 prompt 跳过', () => {
  const { plan } = normalizeWorkflowSpec({
    title: 'X',
    steps: [{ name: 'S1', agents: ['查一'], }, { tasks: [{ task: '查二' }, { prompt: '   ' }, '查三'] }],
  });
  assert.equal(plan.name, 'X');
  assert.equal(plan.phases.map((p) => p.title).join('|'), 'S1|阶段 2');
  assert.deepEqual(plan.phases[0].tasks.map((t) => t.prompt), ['查一']);
  assert.deepEqual(plan.phases[1].tasks.map((t) => t.prompt), ['查二', '查三']);
  assert.equal(plan.taskCount, 3);
});

test('normalizeWorkflowSpec：无可用阶段 → error（调用方回工具错误，不空跑）', () => {
  assert.ok(normalizeWorkflowSpec({}).error);
  assert.ok(normalizeWorkflowSpec({ phases: [] }).error);
  assert.ok(normalizeWorkflowSpec({ phases: [{ title: 'x', tasks: [{ prompt: '  ' }] }] }).error);
  assert.ok(normalizeWorkflowSpec(null).error);
});

test('normalizeWorkflowSpec：超限一律**截断**并记账（不整轮失败），阶段/子任务/prompt 三处上限生效', () => {
  // 阶段数上限：6 个阶段各 1 个任务 → 只留前 4 个
  const manyPhases = Array.from({ length: WORKFLOW_MAX_PHASES + 2 }, (_, i) => ({
    title: 'P' + i,
    tasks: [task(`p${i}`)],
  }));
  const a = normalizeWorkflowSpec(spec(manyPhases)).plan;
  assert.equal(a.phases.length, WORKFLOW_MAX_PHASES);
  assert.equal(a.taskCount, WORKFLOW_MAX_PHASES);
  assert.equal(a.truncated, true);
  // 子任务上限：每阶段 10 个（单阶段上限 6）× 4 阶段 → 单阶段先裁到 6，总量再裁到 12
  const manyTasks = Array.from({ length: WORKFLOW_MAX_PHASES }, (_, i) => ({
    title: 'P' + i,
    tasks: Array.from({ length: WORKFLOW_MAX_TASKS_PER_PHASE + 4 }, (_, j) => task(`p${i}t${j}`)),
  }));
  const { plan } = normalizeWorkflowSpec(spec(manyTasks));
  assert.equal(plan.phases.every((p) => p.tasks.length <= WORKFLOW_MAX_TASKS_PER_PHASE), true);
  assert.equal(plan.taskCount, WORKFLOW_MAX_TASKS, '总量卡在 12：多出来的阶段没有任务可放，自然被丢');
  assert.equal(plan.truncated, true);
  // prompt 超长被裁（4000 上限）
  const long = normalizeWorkflowSpec(spec([{ title: 'A', tasks: [task('x'.repeat(9000))] }])).plan;
  assert.ok(long.phases[0].tasks[0].prompt.length <= 4100);
});

test('workflowLabel：阶段数与子任务数同屏可见（用户据此判断这轮要烧多少额度）', () => {
  const { plan } = normalizeWorkflowSpec(spec([{ title: 'A', tasks: [task('a'), task('b')] }, { title: 'B', tasks: [task('c')] }]));
  assert.equal(workflowLabel(plan), '工作流(审查) · 2 阶段/3 子任务');
  assert.equal(workflowLabel(null), '工作流(未命名) · 0 阶段/0 子任务');
});

test('runWorkflowPlan：阶段按序推进，阶段内按并发上限并行，结果顺序与输入一致', async () => {
  const { plan } = normalizeWorkflowSpec(
    spec([
      { title: 'P1', tasks: [task('a', 'A'), task('b', 'B'), task('c', 'C'), task('d', 'D')] },
      { title: 'P2', tasks: [task('e', 'E')] },
    ]),
  );
  const order = [];
  let live = 0;
  let peak = 0;
  const progress = [];
  const out = await runWorkflowPlan(plan, {
    concurrency: 2,
    onProgress: (l) => progress.push(l),
    runTask: async (t, ctx) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 10));
      order.push(t.title);
      live -= 1;
      return `结论 ${t.title}（阶段 ${ctx.phaseIndex + 1}）`;
    },
  });
  assert.equal(peak, 2, '并发度不得超过上限（4 个任务同时只有 2 个在跑）');
  assert.deepEqual(order, ['A', 'B', 'C', 'D', 'E'], '先入池的先完成；E 要等 P1 全部落地才开跑');
  assert.deepEqual(out.phases.map((p) => p.title), ['P1', 'P2']);
  assert.deepEqual(out.phases[0].tasks.map((t) => t.title), ['A', 'B', 'C', 'D'], '结果顺序按输入，不按完成先后');
  assert.equal(out.ok, 5);
  assert.equal(out.failed, 0);
  assert.equal(progress[0].startsWith('⚡ 工作流(审查) · 2 阶段/5 子任务 · 阶段 1/2'), true);
  assert.equal(progress.at(-1), '⚡ 工作流(审查) · 2 阶段/5 子任务 完成：5 个成功');
});

test('runWorkflowPlan：子任务抛错不中断编排（记失败项），主模型能看到缺哪块', async () => {
  const { plan } = normalizeWorkflowSpec(spec([{ title: 'P1', tasks: [task('a', 'A'), task('b', 'B')] }]));
  const progress = [];
  const out = await runWorkflowPlan(plan, {
    concurrency: 2,
    onProgress: (l) => progress.push(l),
    runTask: async (t) => {
      if (t.title === 'B') throw new Error('端点 500');
      return 'ok';
    },
  });
  assert.equal(out.ok, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.phases[0].tasks[1].ok, false);
  assert.match(out.phases[0].tasks[1].text, /❌ 子任务失败：端点 500/);
  assert.ok(progress.some((l) => l.includes('✖ 子任务 2/2「B」失败：端点 500')));
});

test('runWorkflowPlan：abort 后不再起新阶段/新子任务，结果里留中断标记', async () => {
  const { plan } = normalizeWorkflowSpec(spec([{ title: 'P1', tasks: [task('a', 'A')] }, { title: 'P2', tasks: [task('b', 'B')] }]));
  const ac = new AbortController();
  const seen = [];
  const out = await runWorkflowPlan(plan, {
    signal: ac.signal,
    runTask: async (t) => {
      seen.push(t.title);
      ac.abort(); // 第一个子任务跑完就停
      return 'done';
    },
  });
  assert.deepEqual(seen, ['A'], '第二阶段不该起来');
  assert.equal(out.aborted, true);
});

test('mergeWorkflowResults：分阶段/按子任务汇总，失败与中断如实标注，总体裁剪', () => {
  const { plan } = normalizeWorkflowSpec(spec([{ title: 'P1', tasks: [task('a', 'A'), task('b', 'B')] }]));
  const text = mergeWorkflowResults(plan, {
    aborted: false,
    phases: [
      { title: 'P1', tasks: [{ title: 'A', ok: true, text: '结论 A' }, { title: 'B', ok: false, text: '❌ 子任务失败：端点 500' }] },
    ],
  });
  assert.match(text, /## 工作流\(审查\) · 1 阶段\/2 子任务 结果/);
  assert.match(text, /目标：查清楚/);
  assert.match(text, /### 阶段：P1/);
  assert.match(text, /#### A\n结论 A/);
  assert.match(text, /#### ❌ B/);
  assert.match(text, /有失败或缺口要如实说明/);

  const aborted = mergeWorkflowResults(plan, { aborted: true, phases: [] });
  assert.match(aborted, /本轮被用户中断/);

  // 单条结论与总量都被裁：12 个子任务 × 全文会直接把主会话上下文吃掉
  const big = mergeWorkflowResults(
    plan,
    { phases: [{ title: 'P1', tasks: [{ title: 'A', ok: true, text: 'x'.repeat(9000) }] }] },
    { taskClip: 100, totalClip: 400 },
  );
  assert.ok(big.length <= 400);
  assert.ok(!big.includes('x'.repeat(200)));
});

test('WORKFLOW_TOOL_DEF：schema 接受合法入参、拒绝缺 phases/空任务（真链路里 AI SDK 会标 invalid 不执行）', () => {
  const ok = { name: 'n', phases: [{ title: 't', tasks: [{ prompt: 'p' }] }] };
  assert.deepEqual(WORKFLOW_TOOL_DEF.inputSchema.parse(ok), ok);
  assert.equal(WORKFLOW_TOOL_DEF.inputSchema.safeParse({ name: 'n' }).success, false);
  assert.equal(WORKFLOW_TOOL_DEF.inputSchema.safeParse({ name: 'n', phases: [] }).success, true, '空数组由归一兜底成 error');
  assert.equal(WORKFLOW_TOOL_DEF.inputSchema.safeParse({ name: 'n', phases: [{ title: 't', tasks: [{}] }] }).success, false);
  assert.match(WORKFLOW_TOOL_DEF.description, /只读/);
  assert.match(WORKFLOW_TOOL_DEF.description, /额度/);
});

test('buildUltracodeAuthPrompt：说清「只读子代理」与「烧额度」两个前提', () => {
  const p = buildUltracodeAuthPrompt();
  assert.match(p, /Ultracode/);
  assert.match(p, /Workflow/);
  assert.match(p, /只读/);
  assert.match(p, /额度/);
});
