/**
 * OpenAI 兼容模型 adapter —— 唯一封装 AI SDK 版本细节的地方。
 * 把 streamText 的 fullStream/result 映射成 agent-loop 期望的规范化 modelRun。
 * 已核对 ai@7.0.35：text-delta 的 part.text；tool-call part 含 toolCallId/toolName/input；
 * result.finishReason(str)/toolCalls/responseMessages（response 已废弃，改用 responseMessages）。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { logger } from '../shared/logger.js';

/** 用一个已构造的 languageModel 生成 modelRun（生产=openai-compatible；测试=MockLanguageModelV4）。
 *  tools 省略即纯对话；abortSignal 透传给 streamText 以支持真实中断；
 *  reasoningEffort 经 providerOptions 透传成请求里的 `reasoning_effort`（DeepSeek none/low/high/max 等）。
 *  prepareMessages(msgs) 可选：每次模型请求前的**视图变换**（图片附件内联等），可返回 Promise；
 *  返回的是副本，不改变 agent-loop 持有的对话（落盘/检查点仍是原名）。
 *  modelRun(messages, opts)：opts.disableTools=true 时不带 tools（强制收尾轮；历史 tool 消息保留为上下文）；
 *  opts.signal=本次调用的附加中断源（agent-loop 空闲判死/重试用），与 provider 级 abortSignal 合并。 */
export function streamTextToModelRun(languageModel, tools, abortSignal, reasoningEffort, prepareMessages) {
  return async (messages, opts = {}) => {
    // 视图变换（异步）：图片附件 → file part；失败不静默——prepareMessages 自己 fail-open，
    // 这里只负责 await。变换后的消息只用于本次请求，agent-loop 的对话与落盘不受影响。
    const view = typeof prepareMessages === 'function' ? await prepareMessages(messages) : messages;
    // ai@7 的硬约束：system 不允许混在 messages 里（InvalidPromptError: Use the instructions option instead）。
    // 生产路径（run-openai 的 modelMessages）一直把 system 放在首条 → 真实调用必失败；
    // 单测用 mock 且从未带 system 形态，漏网（2026-10-08 P3 真端点冒烟实锤）。这里统一拆出。
    const instructions = [];
    const chat = [];
    for (const m of Array.isArray(view) ? view : []) {
      if (m && m.role === 'system') {
        const c = m.content;
        instructions.push(
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('')
              : String(c ?? ''),
        );
      } else {
        chat.push(m);
      }
    }
    // run 级中断（用户停止） ∪ 本次调用中断（空闲判死/重试）：哪边先到都断，
    // 但空闲判死只断本次请求、不动整个 run。缺任一侧退化为存在的一侧。
    const callSignal = abortSignal && opts.signal ? AbortSignal.any([abortSignal, opts.signal]) : opts.signal || abortSignal;
    const result = streamText({
      model: languageModel,
      ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
      messages: chat,
      ...(tools && !opts.disableTools ? { tools } : {}),
      ...(callSignal ? { abortSignal: callSignal } : {}),
      ...(reasoningEffort ? { providerOptions: { openaiCompat: { reasoningEffort } } } : {}),
    });
    async function* stream() {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') yield { type: 'text', text: part.text };
        else if (part.type === 'reasoning-delta') {
          // 思考增量不是用户可见输出，但它是**流还活着**的证据：agent-loop 的空闲判死把它当心跳
          //（DeepSeek 等思考模型可能长时间不吐正文；不透传会让 120s 空闲超时误杀正常请求）。
          yield { type: 'reasoning', text: part.text };
        } else if (part.type === 'tool-call') {
          // invalid 是 AI SDK 的校验结论（zod schema 不匹配 / JSON 解析失败 / 未知工具）：
          // 下游 agent-loop 据此**跳过执行**——且不能再追加 tool-result，因为 AI SDK
          // 已把 error 结果放进了 responseMessages（重复同 id 结果会让下一轮请求畸形）。
          // 注意：该校验只认 zod 形态的 inputSchema；MCP 的 JSON Schema 参数类型不被校验
          //（2026-09-30 实测：Read 的 {path:123} 在 jsonSchema 形态下直接放行），那条路径
          //  由 `mcp.js#executeTool` 的轻校验兜底（2026-10-11 补：mcp.logic.js#validateToolInput，
          //  拒绝执行并回报可读错误；判不了的形状仍交 MCP server 自身校验）。
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            invalid: part.invalid === true,
            ...(part.invalid
              ? { errorText: String(part.error?.message || part.error || '工具参数无效').slice(0, 500) }
              : {}),
          };
        } else if (part.type === 'error') {
          const err = part.error instanceof Error ? part.error : new Error(String(part.error?.message || part.error || '模型流错误'));
          // HTTP 细节（状态码/响应体摘要）在 err.message 里，落盘供事后排查（2026-10-08 空输出事故的观测缺口）
          logger.warn('openai-compat', '模型流错误', { err: err.message });
          throw err;
        }
      }
    }
    const finished = (async () => {
      const finishReason = await result.finishReason;
      const toolCalls = await result.toolCalls;
      const responseMessages = await result.responseMessages;
      // usage 透传给 agent-loop（journal 的 tokens 从此不再是恒 0）；abort 时可能拒绝，容错为 null
      let usage = null;
      try {
        usage = await result.usage;
      } catch {
        usage = null;
      }
      return { finishReason, toolCalls, responseMessages, usage };
    })();
    finished.catch(() => {}); // 防悬空：流抛错/abort 时 finished 可能未被 await，避免未处理 rejection 崩进程
    return { stream: stream(), finished };
  };
}

/** 生产用：按凭证造 openai-compatible 模型再包成 modelRun。reasoningEffort 可空（模型无强度档位时不带）。
 *  prepareMessages 由调用方（run-openai）注入：模型边界的消息视图变换（图片附件内联）。 */
export function createOpenAiCompatModelRun({ apiKey, baseURL, model, tools, abortSignal, reasoningEffort, prepareMessages }) {
  const provider = createOpenAICompatible({ name: 'openai-compat', apiKey, baseURL });
  return streamTextToModelRun(provider(model), tools, abortSignal, reasoningEffort, prepareMessages);
}
