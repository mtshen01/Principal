/**
 * 自定义模型（openai-compat）的 Ultracode —— 内置多智能体编排。
 *
 * 背景：Claude 路径的 Workflow 是 **Claude Code CLI 自带的工具**（脚本里 `agent()/parallel()/phase()`），
 * 本仓只负责拼 `ultracode` 关键字前缀（见 `public/js/ultracode.logic.js` 与
 * `docs/superpowers/specs/2026-09-02-workflow-ultracode-design.md`）。自定义模型走的是本仓自研的
 * agent-loop，没有那个工具，所以「Ultracode 对自定义模型不可用」——本模块把这块补上。
 *
 * 与 CLI 版的**两处刻意差异**：
 *  1. 入参是结构化的「阶段/子任务」（JSON），不是 JS 脚本：脚本契约是 CLI 的运行时，我们没有；
 *     且模型产出符合 zod schema 的 JSON 远比产出「符合一个我们没实现 API 的脚本」可靠。
 *  2. 子代理沿用本仓既有的**只读子代理**口径（Read/Glob/Grep/WebFetch/WebSearch/RepoMap，见
 *     `subagent.logic.js`）：编排负责并行调研，改动仍由主模型自己做——写操作要逐个走审批，
 *     放进并行子代理里没人看着，风险与收益不匹配。
 *
 * 本模块零 IO：入参归一、进度文案、结果汇总、并发池调度都是纯函数/注入式（`runTask` 由调用方给），
 * 便于 `node --test` 直测；真实装配（嵌套子代理、审批复用、abort 传播）在 `entrypoints/web/run-openai.js`。
 */
import { z } from 'zod';
import { clipText } from './web-tools.logic.js';

/** 编排规模上限（额度是这里唯一需要防的东西：一轮十几二十个子代理，账单是线性的） */
export const WORKFLOW_MAX_PHASES = 4;
export const WORKFLOW_MAX_TASKS_PER_PHASE = 6;
export const WORKFLOW_MAX_TASKS = 12;
/** 阶段内并发度：再高只是把同一份额度烧得更快，并让活动转录难以阅读 */
export const WORKFLOW_CONCURRENCY = 3;
/** 单个子任务 prompt 上限（字符）：模型自拟，长度无约束 */
export const WORKFLOW_PROMPT_MAX = 4000;
/** 回传主模型的结论裁剪：单条 2000 字符 / 总计 12000 字符。
 *  理由：汇总文本会进主模型上下文（也就进了主会话的上下文窗口），12 个子任务 × 全文会直接把窗口吃掉。 */
export const WORKFLOW_TASK_CLIP = 2000;
export const WORKFLOW_TOTAL_CLIP = 12000;

/**
 * 归一模型给的工作流定义。宽松取字段（phases/steps、tasks/agents、prompt/task/description），
 * 超限**截断而不报错**：已经开跑的一轮不该因为阶段写多了就整轮失败，截断事实写进进度文案。
 * @returns {{plan:{name:string,goal:string,phases:Array<{title:string,tasks:Array<{title:string,prompt:string}>}>,taskCount:number}}|{error:string}}
 */
export function normalizeWorkflowSpec(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const name = clipText(String(raw.name || raw.title || '').trim(), 40) || '未命名';
  const goal = clipText(String(raw.goal || raw.objective || '').trim(), 200);
  const srcPhases = Array.isArray(raw.phases) ? raw.phases : Array.isArray(raw.steps) ? raw.steps : [];
  const phases = [];
  let taskCount = 0;
  let truncated = false;
  for (const p of srcPhases) {
    if (phases.length >= WORKFLOW_MAX_PHASES) {
      truncated = true;
      break;
    }
    const title = clipText(String((p && (p.title || p.name)) || '').trim(), 40) || `阶段 ${phases.length + 1}`;
    const srcTasks = Array.isArray(p?.tasks) ? p.tasks : Array.isArray(p?.agents) ? p.agents : [];
    const tasks = [];
    for (const t of srcTasks) {
      if (tasks.length >= WORKFLOW_MAX_TASKS_PER_PHASE || taskCount >= WORKFLOW_MAX_TASKS) {
        truncated = true;
        break;
      }
      const prompt = clipText(
        String(typeof t === 'string' ? t : (t && (t.prompt || t.task || t.description)) || '').trim(),
        WORKFLOW_PROMPT_MAX,
      );
      if (!prompt) continue; // 空 prompt 的子任务没有意义：跳过而不是让整轮失败
      const tTitle = clipText(String((t && typeof t === 'object' && (t.title || t.description)) || '').trim(), 40);
      tasks.push({ title: tTitle || `子任务 ${tasks.length + 1}`, prompt });
      taskCount += 1;
    }
    if (tasks.length) phases.push({ title, tasks });
  }
  if (!phases.length) return { error: 'phases 为空：至少要有一个带 prompt 的阶段与子任务' };
  return { plan: { name, goal, phases, taskCount, truncated } };
}

/** 工作流短标签（活动转录 / 审批卡 / 完成行共用同一口径） */
export function workflowLabel(plan) {
  const n = plan?.taskCount || 0;
  return `工作流(${plan?.name || '未命名'}) · ${plan?.phases?.length || 0} 阶段/${n} 子任务`;
}

/**
 * 逐阶段并行推进。`runTask(task, ctx)` 由调用方注入（真实实现 = 只读子代理），
 * `onProgress(line)` 收集活动转录行。任何子任务抛错都**不中断编排**：记成失败项，
 * 让主模型自己判断要不要补跑（一个子任务挂掉就整轮炸掉，用户拿到的只有一句报错）。
 *
 * @returns {Promise<{phases:Array<{title:string,tasks:Array<{title:string,ok:boolean,text:string}>}>, ok:number, failed:number, aborted:boolean}>}
 */
export async function runWorkflowPlan(plan, { runTask, onProgress, signal, concurrency = WORKFLOW_CONCURRENCY } = {}) {
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  let ok = 0;
  let failed = 0;
  let aborted = false;
  const results = [];
  for (let i = 0; i < phases.length; i++) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const phase = phases[i];
    onProgress?.(`⚡ ${workflowLabel(plan)} · 阶段 ${i + 1}/${phases.length}「${phase.title}」启动：${phase.tasks.length} 个子任务并行`);
    const done = await runPool(phase.tasks, concurrency, async (task, idx) => {
      if (signal?.aborted) return { title: task.title, ok: false, text: '（已被用户停止）', skipped: true };
      try {
        const text = await runTask(task, { phaseIndex: i, taskIndex: idx, phase, plan });
        const body = String(text || '').trim() || '（子代理未产出结论）';
        ok += 1;
        onProgress?.(`✔ 子任务 ${idx + 1}/${phase.tasks.length}「${task.title}」完成`);
        return { title: task.title, ok: true, text: body };
      } catch (e) {
        failed += 1;
        const msg = e?.message || String(e);
        onProgress?.(`✖ 子任务 ${idx + 1}/${phase.tasks.length}「${task.title}」失败：${clipText(msg, 120)}`);
        return { title: task.title, ok: false, text: `❌ 子任务失败：${msg}` };
      }
    });
    results.push({ title: phase.title, tasks: done });
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    onProgress?.(`⚡ 阶段 ${i + 1}/${phases.length} 完成：${done.filter((d) => d.ok).length}/${done.length} 个子任务给出结论`);
  }
  onProgress?.(
    `⚡ ${workflowLabel(plan)} ${aborted ? '已中断' : '完成'}：${ok} 个成功${failed ? `，${failed} 个失败` : ''}`,
  );
  return { phases: results, ok, failed, aborted };
}

/**
 * 汇总各子任务结论，回传给主模型（由主模型对用户做最终总结）。
 * 带失败/中断标记：主模型看到「有子任务没查成」才会如实告知用户，而不是当成已查清。
 */
export function mergeWorkflowResults(plan, outcome, { taskClip = WORKFLOW_TASK_CLIP, totalClip = WORKFLOW_TOTAL_CLIP } = {}) {
  const lines = [`## ${workflowLabel(plan)} 结果`];
  if (plan?.goal) lines.push(`目标：${plan.goal}`);
  if (outcome?.aborted) lines.push('（本轮被用户中断，下面是不完整的结论）');
  for (const phase of outcome?.phases || []) {
    lines.push('', `### 阶段：${phase.title}`);
    for (const t of phase.tasks || []) {
      lines.push(`#### ${t.ok ? '' : '❌ '}${t.title}`, clipText(t.text, taskClip));
    }
  }
  lines.push('', '要求：把上述结论汇总后直接回答用户；有失败或缺口要如实说明，不要当成已查清。');
  return clipText(lines.join('\n'), totalClip);
}

/** 并发池：固定 concurrency 个 worker 抢任务，保持结果顺序与输入一致 */
async function runPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let next = 0;
  const width = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), list.length || 1));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        out[i] = await worker(list[i], i);
      }
    }),
  );
  return out;
}

/**
 * Workflow 工具定义（自定义模型版）。
 * 描述里把两件事说透：① 子代理是只读的，改动仍由主模型自己做；② 它成倍烧额度，别为小改动用它。
 */
export const WORKFLOW_TOOL_DEF = Object.freeze({
  description:
    '多智能体编排（用户已在本会话开启 Ultracode）：把一件能拆成多路的工作拆成若干「阶段」，每个阶段里放多个互不依赖的**只读**子任务（读文件/搜索/抓网页/查代码地图），并行跑完后各子任务结论回给你，由你汇总回答用户。' +
    '子任务不能写文件或执行命令——改动、命令、最终交付都由你在编排结束后自己做。' +
    '它会成倍消耗额度：只在任务确实能并行拆解（多点排查、多文件审查、多方案对比、交叉验证）时才用，单个小改动自己做更快更省。',
  inputSchema: z.object({
    name: z.string().describe('工作流短名（展示与转录用，如「支付模块审查」）'),
    goal: z.string().optional().describe('一句话总目标，会附给每个子任务当背景'),
    phases: z
      .array(
        z.object({
          title: z.string().describe('阶段名（展示用，如「并行调研」）'),
          tasks: z
            .array(
              z.object({
                title: z.string().optional().describe('子任务短名（展示用）'),
                prompt: z
                  .string()
                  .describe('交给该子代理的具体任务与期望产出。它看不到你的对话历史，prompt 必须自包含'),
              }),
            )
            .describe('本阶段并行执行的只读子任务（最多 6 个）'),
        }),
      )
      .describe(`阶段按顺序推进，阶段内并行；最多 ${WORKFLOW_MAX_PHASES} 个阶段、合计 ${WORKFLOW_MAX_TASKS} 个子任务`),
  }),
});

/**
 * 授权说明（只在开了 Ultracode 的那一轮追加到系统提示词末尾）。
 * 为什么不常开：CLI 的 Workflow 靠用户显式授权，额度不可控的工具不该由模型自行决定何时用。
 */
export function buildUltracodeAuthPrompt() {
  return [
    '',
    '## Ultracode（本会话由用户显式开启）',
    '用户已授权你使用 `Workflow` 工具做多智能体编排。当任务能拆成多路互不依赖的调研（多点排查、多文件审查、多方案对比、交叉验证）时，优先用它把子任务并行跑一遍再汇总。',
    '注意：① 子代理是只读的，文件改动与命令由你自己执行；② 编排会成倍消耗额度，能从简就从简；③ 单个小改动不值得起一个工作流，直接做。',
  ].join('\n');
}
