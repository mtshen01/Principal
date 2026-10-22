/**
 * `tracking_report` —— 同事对话 agent 查数据/埋点的入口（P4）。
 *
 * 形态与 feature 前缀路径（`帮我查数据:`）不同：**后台异步 kick-off**。
 * 分析实测 44s~275s（预算 12 分钟），远超同事对话单轮 120s 的超时预算 ——
 * 工具必须立即返回，结果由 tracking-stats 回发到**提问的来源会话**（群里问的回群里并 @
 * 提问人，私聊问的回私聊，路由见 shared/reply-target.js —— 与主回复同一条规则，
 * 否则会出现「群里问、答复跑进私聊」的错位）。
 * 即时应答刻意关掉（`ack:false`）：agent 自己会先回同事一句，重复会像两个机器人。
 *
 * 安全边界完全复用自由形路径的四层防线（llm-sql-agent / sql-guard / sql_exec.py / sql-audit），
 * **本文件不新增任何安全判断**（分散的安全逻辑等于没有安全逻辑）。
 */
import { z } from 'zod';
import { registerAgentTool } from '../../capabilities/agent-tools.js';
import { getActiveBot } from '../../store/settings.js';
import { sendTextToTarget } from '../../integrations/lark.js';
import { resolveReplyTarget } from '../../shared/reply-target.js';
import { logger } from '../../shared/logger.js';
import { startFreeformQuery as realStartFreeform } from './freeform.js';

export const TRACKING_REPORT = 'tracking_report';

/** 默认发送：取当前启用 bot 的凭证，把结果发到回复目标（群聊回群并 @ / 私聊回私聊） */
async function defaultSend(target, text) {
  const bot = getActiveBot();
  if (!bot?.appId || !bot?.appSecret) {
    // 这条路径走到 = 同事永远收不到结果。触发条件苛刻（飞书长连接同源凭证），但必须留痕
    logger.warn('tracking-agent', '飞书凭证不完整，数据结果无法送达', { to: target?.receiveId });
    return;
  }
  await sendTextToTarget({ appId: bot.appId, appSecret: bot.appSecret }, target, text);
}

/**
 * 构造工具定义（导出供单测注入替身；模块加载时用默认真实依赖注册）。
 * @param {object} [deps] { startFreeformQuery, sendText }
 */
export function buildTrackingReportTool(deps = {}) {
  const startFn = deps.startFreeformQuery || realStartFreeform;
  const sendText = deps.sendText || defaultSend;

  return {
    name: TRACKING_REPORT,
    description:
      '查生产数据/埋点统计（探表 + 写 SQL + 出结论，几分钟后结果**直接发给你**，不用在这里等）。' +
      '适合「某某功能最近 7 天的数据」「上周新增用户里有多少下单了」这类数据问题；' +
      '需求状态、代码问题不要用它。',
    danger: 'safe',
    roles: ['ops', 'product'],
    schema: {
      question: z.string().describe('要查的数据问题，大白话即可，例如「上周新增用户里有多少下单了」'),
    },
    handler: async ({ question }, ctx) => {
      const openId = ctx?.openId || '';
      if (!openId) return { error: '这台机器人还不知道这位同事的发送地址，查完也送不过去' };
      const text = String(question || '').trim();
      if (!text) return { error: '要查什么？给一个问题描述' };

      // 回复目标与主回复同一份判定：群里问的回群里（@ 提问人），私聊问的回私聊
      const target = resolveReplyTarget({ openId, chatId: ctx?.chatId, chatType: ctx?.chatType });

      const r = await startFn({
        text,
        userId: openId, // 限流与审计口径与老路径同键
        userName: null,
        chatId: ctx?.chatId || '', // HTML 报告附件用；空则只发文字结论
        reply: (t) => sendText(target, t),
        ack: false, // agent 会先回执
      });
      if (!r?.started) return { error: r?.error || '数据查询没排上队，请稍后再试' };
      return {
        started: true,
        note: '查询已在后台开始，几分钟后结果会直接发给这位同事（你只需告诉他稍等，不用在这里等）',
      };
    },
  };
}

// 模块加载即注册（插件停用 → 本文件不被 import → 工具自然缺席）
registerAgentTool(buildTrackingReportTool());
