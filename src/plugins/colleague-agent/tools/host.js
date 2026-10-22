/**
 * `notify_host` —— 同事对话 agent 向主机转达消息的入口（P4）。
 *
 * 定位：agent 不能替主机做决策（排期、优先级、阶段推进等，见 prompt.js 硬约束 3），
 * 需要主机拍板或知悉时，用这个工具把话**原样带过去**。notify 档：不写撤销台账
 * （发消息没有可撤销性，也不是对系统的写操作）。
 *
 * 发送目标 = 基础设置里的「我的飞书 open_id」（getMyFeishuOpenId，与 task-notify 等
 * 同一个人）。署名由服务端前置（模型只给正文）—— 让模型自己署名会漏、会编。
 */
import { z } from 'zod';
import { registerAgentTool } from '../../../capabilities/agent-tools.js';
import { getActiveBot, getMyFeishuOpenId } from '../../../store/settings.js';
import { sendTextToUser } from '../../../integrations/lark.js';
import { logger } from '../../../shared/logger.js';

export const NOTIFY_HOST = 'notify_host';

/** 转达正文上限：一两句说清即可，超长说明本来就不适合私信 */
const TEXT_MAX = 1000;

/**
 * 构造工具定义（导出供单测注入替身；模块加载时用默认真实依赖注册）。
 * @param {object} [deps] { getMyFeishuOpenId, getActiveBot, sendText }
 */
export function buildHostTool(deps = {}) {
  const getOpenId = deps.getMyFeishuOpenId || getMyFeishuOpenId;
  const getBot = deps.getActiveBot || getActiveBot;
  const sendText =
    deps.sendText || (async (openId, text) => sendTextToUser({ appId: getBot()?.appId, appSecret: getBot()?.appSecret }, openId, text));

  return {
    name: NOTIFY_HOST,
    description:
      '把一件事转达给主机（需求负责人）。需要主机拍板或知悉的事（排期、优先级、阶段推进、投诉、异常）用它，' +
      '不要自己在对话里表态。正文一两句说清楚，署名由系统加。',
    danger: 'notify',
    roles: ['*'],
    schema: {
      text: z.string().describe('要转达给主机的内容（一两句说清；不要写"请转达"之类的开头）'),
    },
    handler: async ({ text }, ctx) => {
      const clean = String(text || '').trim().slice(0, TEXT_MAX);
      if (!clean) return { error: '要转达什么？' };

      const openId = getOpenId();
      if (!openId) return { error: '主机还没配置飞书 open_id，转达不了' };
      const bot = getBot();
      if (!bot?.appId || !bot?.appSecret) return { error: '机器人凭证不完整，转达不了' };

      const signature = `[${ctx?.colleagueName || '同事'}（${ctx?.roleLabel || '同事'}）] `;
      try {
        await sendText(openId, signature + clean);
      } catch (e) {
        // 发送失败必须如实回给模型（它要告诉同事"没发出去"），日志留全文
        logger.warn('colleague-agent', 'notify_host 发送失败', { openId, err: e?.message || String(e) });
        return { error: '消息没发出去，请稍后再试' };
      }
      return { ok: true, reply: '已转达给主机。' };
    },
  };
}

// 模块加载即注册（插件停用 → 本文件不被 import → 工具自然缺席）
registerAgentTool(buildHostTool());
