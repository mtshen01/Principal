/**
 * 「委托同事对话」的两个模型工具 —— 接在 openai-compat 内置工具层（run-openai.js 装配）。
 *
 * 与内置文件工具的分工：文件工具解决「手边能查到的事」，本工具解决
 * 「只有同事才知道的事」——开发途中卡在后端字段/产品口径上时，派一个子对话去问。
 *
 * AskColleague 非阻塞（发卡片、拿问题ID）；WaitColleagueReply 阻塞等结论。
 * 追问与判定由 capabilities/feishu-ask.js 的子引擎负责，模型只消费最终结论。
 */
import { z } from 'zod';
import { askColleague, waitForReply } from './feishu-ask.js';
import { MAX_FOLLOW_UPS, formatTranscript } from './feishu-ask.logic.js';

export const FEISHU_ASK_TOOL_NAMES = Object.freeze(['AskColleague', 'WaitColleagueReply']);
/** 等待只是占用时间、无副作用：免审批放行（提问本身仍走审批卡） */
export const FEISHU_ASK_READONLY_TOOLS = new Set(['WaitColleagueReply']);

const TOOL_DEFS = Object.freeze({
  AskColleague: {
    description:
      '向同事名册里的同事（如后端/产品）发飞书卡片提问。非阻塞：立即返回问题ID；' +
      '系统会自动与对方追问直到得出完整结论。需要结论时用 WaitColleagueReply 等待。' +
      '**先自查再问**：提问前先用 Read/Grep 查项目现有代码与惯例 —— 凡是照已有先例/惯例就能定的事' +
      '（如「弹框点遮罩是否关闭」，项目里现有弹框都关，那就直接照做），一律自己定，不要拿来问同事；' +
      '只问项目里查不到、只有业务方/同事才知道的事（后端字段口径、产品规则、外部系统约束等）。' +
      '**一次只问一个最关键的问题**（不要在一张卡里堆多个问题），并给出 2~4 个可点选的选项。',
    inputSchema: z.object({
      role: z.string().optional().describe('目标职位：backend=后端 / frontend=前端 / product=产品 / qa=测试 / ops=运营 / design=UI设计'),
      name: z.string().optional().describe('目标同事姓名（与 role 二选一或同时给出；同职位多人时必须给）'),
      question: z.string().describe('要问清楚的问题。一次只问一个最关键的问题，写完整、具体；不要在一句话里并列多个待确认点'),
      options: z
        .array(z.string().min(1))
        .min(2)
        .max(4)
        .describe('让对方点选的 2~4 个候选答案（简洁、互斥、覆盖主要可能）。对方也可自己打字回复；实在无法枚举时给「知道了 / 不清楚 / 稍后再说」这类兜底选项'),
      context: z.string().optional().describe('补充背景（错误现象、涉及接口/字段等），会一并展示给对方'),
    }),
  },
  WaitColleagueReply: {
    description:
      '等待某条提问的最终结论（阻塞，直到得出结论 / 超时 / 运行被停止）。' +
      'question_id 来自 AskColleague；等待期间系统保持活跃。',
    inputSchema: z.object({
      question_id: z.string().describe('AskColleague 返回的问题ID'),
      timeout_seconds: z.number().int().positive().max(1800).optional().describe('最长等待秒数（默认 600，上限 1800）'),
    }),
  },
});

export function createFeishuAskTools({ runId = null, convId = null, signal, pulse, activity } = {}, deps = {}) {
  const ask = deps.ask || askColleague;
  const wait = deps.wait || waitForReply;

  async function executeTool(name, input = {}) {
    if (name === 'AskColleague') {
      const r = await ask({
        role: input.role,
        name: input.name,
        question: input.question,
        options: input.options,
        context: input.context,
        runId,
        convId,
      });
      if (r.error) return `⚠️ 提问失败：${r.error}`;
      return (
        `已向「${r.colleague.name}」发送飞书询问卡（问题ID：${r.questionId}）。` +
        `系统会自动与对方追问直到得出结论（最多 ${MAX_FOLLOW_UPS} 轮）。` +
        `对方可点选选项或直接回复；你也可以在执行台的同一张卡上直接选定答案（会立即结算并通知对方）。` +
        `你可以先继续其他工作，需要结论时调用 WaitColleagueReply（question_id=${r.questionId}）。`
      );
    }
    if (name === 'WaitColleagueReply') {
      const timeoutMs = Number(input.timeout_seconds) > 0 ? Number(input.timeout_seconds) * 1000 : undefined;
      const r = await wait(input.question_id, { timeoutMs, signal, pulse });
      switch (r.status) {
        case 'concluded': {
          activity?.(`📨 已与 ${r.colleagueName} 得出结论`);
          return (
            `✅ 已与「${r.colleagueName}」沟通得出结论（追问 ${r.followUps} 轮）：\n${r.conclusion}\n\n` +
            `— 对话原文 —\n${formatTranscript(r.transcript)}`
          );
        }
        case 'abandoned':
          return (
            `⚠️ 与「${r.colleagueName}」的对话追问 ${r.followUps} 轮仍未得出结论（已停止自动追问）。` +
            `请基于以下对话自行判断，或换人/换个问法重新提问：\n${formatTranscript(r.transcript)}`
          );
        case 'expired':
          return `⏳ 提问已过期：「${r.colleagueName || '同事'}」长时间未回复（问题ID ${input.question_id} 已失效）。可以稍后重新提问，或先按假设推进。`;
        case 'timeout':
          return `⏳ 等待超时，已取消本次提问（避免继续打扰「${r.colleagueName || '同事'}」）。你可以继续其他工作；需要时重新发起提问。`;
        case 'aborted':
          return '🛑 等待已停止（运行中断）。';
        case 'busy':
          return '⚠️ 该提问已在等待中，不要重复调用 WaitColleagueReply。';
        default:
          return `⚠️ 未找到该提问（可能已超时或已结束）：${r.reason || input.question_id}`;
      }
    }
    throw new Error(`未知的飞书询问工具：${name}`);
  }

  return { toolDefs: TOOL_DEFS, executeTool };
}
