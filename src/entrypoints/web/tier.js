/** web 入口：任务档位判定（关键词快判 + Haiku 极速分类，自动选 model/effort 省额度） */
import { runClaude } from '../../integrations/claude.js';
import { claudeAuthOpts } from '../../capabilities/token-rotation.js';
import { logger } from '../../shared/logger.js';
import { resolveTaskModel, resolveTaskTarget } from '../../shared/model-tasks.js';

/** Auto 判档分类器的 systemPrompt（Claude / 自定义模型两条通道共用同一份） */
const TIER_SYSTEM_PROMPT =
  '你是任务档位分类器。只输出一个词：light / medium / heavy，不要任何解释。\n' +
  'light：闲聊、问候、无需读代码的简单问答。\n' +
  'medium：一般代码问题、小改动、单文件分析、常规任务。\n' +
  'heavy：复杂开发或重构、多文件排障、架构设计、长链路 agentic 任务。';

/** 关键词快速判档（省一次分类往返）；命中返回 {model,effort}，未命中返回 null */
export function quickTier(prompt) {
  const p = prompt.trim();
  if (p.length < 12 || /^(你好|您好|hi|hello|在吗|在么|谢谢|多谢|你是谁|介绍一下|自我介绍)/i.test(p))
    return { model: 'claude-haiku-4-5', effort: 'medium' };
  if (
    /(重构|refactor|架构|多个文件|整个项目|全项目|迁移|migrat|实现一个|开发|新增功能|修复|排查|debug|部署|设计方案)/i.test(
      p,
    )
  )
    return { model: 'claude-opus-4-8', effort: 'high' };
  return null;
}

/** 用 Haiku 极速判定任务档位 → 自动选 model/effort（省额度）；失败/超时降级 medium */
export async function classifyTier(prompt) {
  const quick = quickTier(prompt);
  if (quick) {
    logger.info('tier', 'auto 判档（关键词快判）', { model: quick.model, effort: quick.effort });
    return quick;
  }
  let out = '';
  // 功能模型：Auto 判档可指向自定义模型（openai-compat）——独立通道，与订阅池无关
  const target = resolveTaskTarget('autoTier');
  if (target.provider === 'openai-compat') {
    const { runOpenAiOnce } = await import('../../capabilities/llm-openai-agent.js');
    const r = await runOpenAiOnce({
      credId: target.credId, model: target.model,
      prompt: prompt.slice(0, 800),
      systemPrompt: TIER_SYSTEM_PROMPT,
      timeoutMs: 8000, // 与 Claude 通道同预算，避免拖住发送
      logTag: 'tier/auto',
    });
    out = r.text || '';
  } else {
    const model = resolveTaskModel('autoTier') || 'claude-haiku-4-5';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000); // 分类超时兜底，避免拖住发送
    try {
      await runClaude(prompt.slice(0, 800), {
        ...claudeAuthOpts(), // 判档也跟随备用账号轮换
        model,
        permissionMode: 'default',
        persistSession: false, // 内部一次性调用不落盘——否则在左栏历史里生成与真会话同标题的伪会话，极易误点
        abortController: ac,
        // 通配符禁全部工具（同 llm-classify.js）：列名黑名单补不全，
        // 且这里原本连 Agent/Task 都漏了——判档模型一旦起子代理就会吃掉整轮。
        disallowedTools: ['*'],
        systemPrompt: { type: 'custom', prompt: TIER_SYSTEM_PROMPT },
        onText: (t) => (out += t),
        onResult: (i) => {
          if (!out && i.result) out = i.result;
        },
      });
    } catch {
      /* 超时/失败 → medium 兜底 */
    } finally {
      clearTimeout(timer);
    }
  }
  const t = out.toLowerCase();
  // 判档结果必须留下记录：此前 systemPrompt 字段名写错（custom/content vs prompt），
  // 分类器拿不到指令、输出永远命中不了关键词，全部静默落 sonnet/medium 兜底而无人察觉。
  let tier;
  if (t.includes('heavy')) tier = { model: 'claude-opus-4-8', effort: 'high' };
  else if (t.includes('light')) tier = { model: 'claude-haiku-4-5', effort: 'medium' };
  else tier = { model: 'claude-sonnet-4-6', effort: 'medium' };
  logger.info('tier', 'auto 判档（分类器）', { raw: out.slice(0, 60), model: tier.model, effort: tier.effort });
  return tier;
}
