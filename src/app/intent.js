/**
 * 意图识别 —— 收缩为四类显式意图 + other，逐层短路，绝不瞎归类：
 *   L0 寒暄快路 → L1 强意图前缀（零成本）→ L3 一次 Haiku 合并分类
 *   （bug/feature/question/material，10s 超时）→ L4 other（引导文案兜底）
 *
 * 2026-10-09（P4）**动作意图退役**：action-runner 的意图路径已从插件注册表摘除，
 * 同事侧动作执行走 colleague-agent 的 `run_action` 工具；陌生人不再能靠关键词触发脚本。
 * 随之删除：L2 动作关键词单命中、L3 的 action 候选与消歧、via/actionId/actionName 字段、
 * L1 question 的「让路动作」绕行。「L2 关键词表」即 action-configs 的 keywords 字段，
 * 声明保留（历史数据不动），只是不再有人读它的路由用途。
 * 想恢复：本文件的 action 分支 + `plugins/action-runner/index.js` 的 features 一起加回。
 *
 * 收缩原因（真实事故，勿放宽）：
 * - 旧版宽泛关键词（希望/建议/优化/无法/不能用…）几乎人人命中，随口一说被立案成需求/故障。
 * - 旧版未命中要串两次 LLM（feedback 四分类 30s + action 消歧 30s），用户等一分钟见不到回复。
 * L3 失败/超时一律落 other（不再退回全文关键词兜底——那正是误判来源），让用户按引导重说一次。
 */
import { matchStrongIntent } from './intent-keywords.js';
import { runClassifierOnce } from '../capabilities/llm-classify.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/** 意图分类超时预算：用户正在等第一条回复，10s 到点就落引导文案（其余分类点仍用 30s） */
export const INTENT_CLASSIFY_TIMEOUT_MS = 10_000;

/** LLM 分类输入的正文上限（长文只取首段判意图，够用且省 token） */
const CLASSIFY_TEXT_MAX = 500;

// —— 寒暄 / 闲聊本地快路：整条消息仅由「问候词 + 标点 / 表情 / 语气助词」组成时判为闲聊，
//    直接落 other（免一次分类模型调用）。保守匹配：宁可漏判（退化为走分类），绝不误吞真实请求。
//    正则不加 g flag（.test() 有状态会让重复调用结果不确定，本项目踩过）。
//
//    ⚠️ 选择支里**不得**出现「一个候选是另一个候选的重复」（曾同时收 byebye 和 bye）：
//    外层 `+` 会让 'byebyebye…' 的分解方式呈斐波那契增长 → 灾难性回溯。实测 'bye'.repeat(44)
//    要 87s，repeat(60) 数小时不返回。本函数是同步正则、跑在 classify 第一行，一旦爆炸整个
//    Node 事件循环被占死（WS 心跳 / 去重 / 所有会话全停，abort 与 timeout 也救不了 —— 它们都
//    要事件循环才能触发）。新增候选词前请先确认它不能由其他候选拼出来。
const CHITCHAT_RE =
  /^(?:[\s\p{P}\p{S}呀啊哦喔嗯呢啦哈嘿哟额诶~]|你好|您好|哈喽|哈啰|嗨|hi|hello|hey|在吗|在不在|在么|在|早上好|中午好|下午好|晚上好|早安|晚安|早|谢谢|多谢|谢啦|感谢|thanks|thank\s*you|thx|辛苦了|辛苦啦|辛苦|收到|好的|好嘞|okay|ok|明白了|明白|了解|再见|拜拜|bye)+$/iu;

/** 寒暄消息的长度上限：超过即不可能是寒暄，直接判否 */
const CHITCHAT_MAX_LEN = 60;

export function isChitchat(text) {
  const t = String(text ?? '').trim();
  if (!t) return true; // 空 / 纯空白
  // 灾难性回溯护栏（勿删）：CHITCHAT_RE 是带 `+` 的多选择支正则，对长输入天然有回溯放大风险，
  // 而它同步执行在 classify 第一行 —— 一旦爆炸会占死整个事件循环（详见 CHITCHAT_RE 上方注释）。
  // 寒暄不可能超过 60 字，这里先卡长度，把最坏情况的输入规模钉死。
  if (t.length > CHITCHAT_MAX_LEN) return false;
  return CHITCHAT_RE.test(t);
}

/**
 * 统一返回形状（env/keyword 保留字段，dispatch 日志与旧调用方仍读）。
 * strong：本条意图是否来自 L1 强前缀命中。feedback / project-qa 据此判断「是否只发了前缀没带正文」，
 * 不必再各自调一次 matchStrongIntent（重复计算，且 project-qa 无从判断）。默认 false。
 */
function result(intent, extra = {}) {
  return { intent, body: '', strong: false, env: null, keyword: null, ...extra };
}

/**
 * L3：一次 Haiku 合并分类（bug/feature/question/material/other 五选一）。
 * @param {Function} [runOnce] 注入分类器替身（单测用；默认走 runClassifierOnce）
 * @returns {{ type:string } | null} null = 超时/失败/解析不出
 */
async function quickClassify(text, { hasMaterials, runOnce = runClassifierOnce } = {}) {
  const prompt =
    `你是团队消息分类器，仅输出一行 JSON，不要任何解释。\n` +
    `判断这条消息属于哪类：\n` +
    `- bug：报告软件故障/异常，期望修复\n` +
    `- feature：提出需求/改进，期望实现\n` +
    `- question：询问项目/功能/代码相关的问题，期望得到解答（不期望改动代码）\n` +
    `- material：仅提供参考材料（接口文档/设计稿/日志片段等），本身不构成独立诉求\n` +
    `- other：都不是（寒暄/闲聊/无关内容）\n` +
    (hasMaterials ? `（提示：该用户刚发过待归属的参考材料，这条消息很可能是对应的需求/故障描述）\n` : '') +
    `消息（截取首 ${CLASSIFY_TEXT_MAX} 字）：\n「${String(text ?? '').slice(0, CLASSIFY_TEXT_MAX)}」\n\n` +
    `严格输出：{"type":"bug|feature|question|material|other"}`;

  const j = await runOnce({
    prompt,
    model: config.intent.classifyModel,
    task: 'intent',
    logTag: 'intent/quick',
    timeoutMs: INTENT_CLASSIFY_TIMEOUT_MS,
  });
  if (!j) return null;
  if (['bug', 'feature', 'question', 'material', 'other'].includes(j.type)) return { type: j.type };
  return null;
}

/**
 * 统一入口。
 * @param {string} text
 * @param {{ hasMaterials?: boolean, runClassifierOnce?: Function }} [opts]
 *   hasMaterials：该用户当前会话是否有待归属材料（影响分类提示）；
 *   runClassifierOnce：单测注入的分类器替身
 * @returns {Promise<{intent:string, body:string, strong:boolean, env:null, keyword:null}>}
 *   strong=true 仅当意图来自 L1 强前缀（L0/L3/L4 一律 false）
 */
export async function classify(text, opts = {}) {
  const hasMaterials = !!opts.hasMaterials;

  // L0 寒暄：免 LLM（问候语不可能是显式诉求）
  if (isChitchat(text)) return result('other');

  // L1 强意图前缀：免 LLM，body 为剥掉前缀的正文。
  const strong = matchStrongIntent(text);
  if (strong) {
    logger.info('intent', 'L1 强前缀命中', { type: strong.type });
    return result(strong.type, { body: strong.body, strong: true });
  }

  // L3 一次 Haiku 合并分类（P4 起候选里没有 action —— 动作意图已退役）
  const r = await quickClassify(text, { hasMaterials, runOnce: opts.runClassifierOnce });
  if (r && r.type !== 'other') {
    logger.info('intent', 'L3 语义分类命中', { type: r.type });
    return result(r.type);
  }

  // L4 兜底：不猜，交给 dispatch 回引导文案
  return result('other');
}
