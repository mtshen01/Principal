import { logger } from '../shared/logger.js';
import { classifyModelError, nextRetryDelayMs, resolveRetryOptions } from './model-retry.logic.js';

/**
 * Provider/SDK 无关的手动 agent loop。依赖注入便于离线单测，不碰真实 AI SDK。
 *   modelRun(messages, opts?) -> { stream, finished } | Promise<{ stream, finished }>
 *     opts.disableTools=true 时不向模型暴露任何工具（强制收尾轮用；历史 tool 消息保留为上下文）
 *     opts.signal：本次请求的附加中断源（空闲判死/重试用；真 adapter 与 run 级 signal 合并）
 *     stream: AsyncIterable，产出 { type:'text', text } | { type:'tool-call', toolCallId, toolName, input }
 *              （{ type:'reasoning' } 等未知事件一律忽略——但算「流还活着」的心跳）
 *     finished: Promise<{ finishReason:string, toolCalls:Array<{toolCallId,toolName,input}>, responseMessages:Array, usage? }>
 *   executeTool(toolName, input) -> Promise<any>（真实实现由 MCP 提供；v1 无工具时不会被调用）
 * hooks: { onText(t), onActivity({name,input}), onResult({subtype,result,is_error,...}),
 *          onRetry({retry,max,delayMs,kind,error}), canUseTool(name,input) -> Promise<{behavior:'allow'|'deny', message?}>,
 *          takeSteerMessages() -> [{id,text}]，shouldPreempt() -> boolean }
 *          （后两个为 P1-10 步边界 steer：取走持有插话并入下一轮请求；本轮尚无可见产出时抢占当前请求）
 *
 * 预算（maxSteps）：默认 **无上限（Infinity）**——对齐 Claude Code / OpenCode 的默认口径；
 * 0/空/非法值同样视为 ∞。设了有限上限且用尽时走 **强制收尾**（OpenCode 式）：注入
 * 「工具已禁用、只能文字总结」指令再要一轮，绝不静默截断（2026-10-08 事故：
 * docs/superpowers/specs/2026-10-08-openai-run-empty-output-fix.md；收尾设计：
 * docs/superpowers/specs/2026-10-08-unlimited-steps-and-forced-wrapup.md）。
 *
 * 重试与空闲超时（P0-④）：每步模型请求失败按 model-retry.logic.js 的口径退避重试
 * （默认 5 次、2s 起步、60s 封顶；120s 无任何流事件判死并重建请求）；仅在**本步还没向
 * 用户输出过任何内容**时重试——已吐出的文本/活动无法撤回，重发会重复。设计：
 * docs/superpowers/specs/2026-10-11-model-stream-retry-and-idle-timeout-design.md。
 *
 * 返回 { result, messages, steps?, exhausted?, wrappedUp?, inputTokens?, outputTokens? }。
 */
const WRAP_UP_PROMPT =
  '系统提示：已到达工具调用步数上限，工具已禁用。只能输出文字，不得再调用任何工具。' +
  '请在回复中：1) 说明已达到步数上限；2) 汇总已完成的工作；3) 列出未完成的事项；4) 给出建议的下一步。';

/** 中断信号的统一错误（外层 catch 按 signal.aborted 静默收场，与模型错误区分开） */
function abortedError() {
  const e = new Error('已被用户停止');
  e.name = 'AbortError';
  e.code = 'aborted';
  return e;
}

/** 带 code 的自产步错误：让 classifyModelError 不依赖文案识别（空闲判死 / finishReason=error） */
function stepError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 可中断的 sleep：退避等待期间用户点停止 → 立即 reject（不再重试） */
function sleepAbortable(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

const IDLE = Symbol('model-stream-idle');
const PREEMPT = Symbol('steer-preempt');
// 抢占巡检粒度（P1-10，spec 2026-10-11-openai-step-steer-design）：模型流静默期（只思考、零事件）
// 没有可挂钩的唤醒点——Codex 的 cancel token 能即时取消是因为采样流在它同进程内；我们跨
// store/provider 边界，用一次轻量巡检兜底，且只在本轮 attempt 尚无任何可见产出时才触发切断。
const PREEMPT_POLL_MS = 250;

/**
 * 跑一步模型请求：**流重试 + 空闲超时**（P0-④；判定口径见 model-retry.logic.js）。
 *  - 每次尝试都用同一份 messages 重建请求（失败尝试不落账 → 天然幂等）；
 *  - 只有「本步还没向用户输出过任何内容」时才重试：已吐出的文本/活动无法撤回，
 *    重发会让气泡出现重复段落——此时按原样失败，交给 run 对账/用户「继续」兜底；
 *  - 空闲计时器把**任何**流事件当心跳（含适配器透传的 reasoning 增量）；
 *  - preempt=true 且 hooks.shouldPreempt() 为真且本 attempt **尚无任何产出**：切断当前请求并抛
 *    `code='steer_preempt'`（P1-10 步边界 steer；外层同号重来、不重试——见 runAgentLoop）；
 *    已产出则等本轮自然结束由步边界注入，绝不产生「界面有、历史无」的半截输出；
 *  - 失败且不再重试时抛错；已产出的文本挂在 `error.partialText` 上交给调用方落账。
 *
 * @returns {Promise<{done:object, text:string, retries:number}>}
 */
async function runModelStep({ modelRun, messages, opts = {}, signal, retry, hooks, forward = 'all', preempt = false }) {
  for (let attempt = 1; ; attempt++) {
    const attemptAbort = new AbortController();
    const onOuterAbort = () => attemptAbort.abort();
    signal?.addEventListener?.('abort', onOuterAbort, { once: true });
    let idleTimer = null;
    let idleWait = null; // 每轮武装都重建 promise：旧的被清掉的定时器即使恰好触发也无害
    const armIdle = () => {
      clearTimeout(idleTimer);
      let fire;
      const promise = new Promise((resolve) => {
        fire = resolve;
      });
      idleWait = { promise, fire };
      idleTimer = setTimeout(() => fire(IDLE), retry.streamIdleMs);
    };
    let text = '';
    let emitted = false;
    // 抢占（P1-10）：武装后由 250ms 巡检唤醒；命中则切断本次请求、抛 steer_preempt。
    let preemptWait = null;
    let preemptTimer = null;
    try {
      // modelRun 可为异步（真 adapter 的 prepareMessages 要在请求前读图等）；同步实现 await 立即 resolve
      const { stream, finished } = await modelRun(messages, { ...opts, signal: attemptAbort.signal });
      // 失败尝试可能不再 await finished：先挂兜底 catch，避免未处理 rejection（真 adapter 内部同款防悬空）
      if (finished && typeof finished.catch === 'function') finished.catch(() => {});
      const it = stream[Symbol.asyncIterator]();
      armIdle();
      if (preempt && typeof hooks.shouldPreempt === 'function') {
        let fire;
        preemptWait = new Promise((resolve) => {
          fire = resolve;
        });
        preemptTimer = setInterval(() => {
          let hit = false;
          try {
            hit = !emitted && hooks.shouldPreempt();
          } catch {
            hit = false; // 巡检是尽力而为：钩子出错不得炸进程（下个周期再试）
          }
          if (hit) fire(PREEMPT);
        }, PREEMPT_POLL_MS);
      }
      for (;;) {
        const nextPromise = it.next();
        const outcome = await Promise.race([nextPromise, idleWait.promise, ...(preemptWait ? [preemptWait] : [])]);
        if (outcome === PREEMPT) {
          attemptAbort.abort(); // 真 adapter 据此断开底层请求；不 aborted 的假流由竞速直接放弃
          nextPromise.then(() => {}, () => {}); // 迟到结果已无人消费
          throw stepError('用户插话抢占当前请求', 'steer_preempt');
        }
        if (outcome === IDLE) {
          attemptAbort.abort(); // 真 adapter 据此断开底层请求；不 aborted 的假流由竞速直接放弃
          nextPromise.then(() => {}, () => {}); // 迟到结果已无人消费
          throw stepError(`模型流空闲超时（${retry.streamIdleMs}ms 未收到任何事件）`, 'stream_idle');
        }
        armIdle(); // 收到事件才算活着
        if (outcome.done) break;
        const ev = outcome.value;
        if (ev?.type === 'text') {
          text += ev.text;
          emitted = true;
          hooks.onText?.(ev.text);
        } else if (ev?.type === 'tool-call' && forward === 'all') {
          // invalid 调用照样上报 activity（带标记），由上层提示「参数无效」；
          // 执行侧必须跳过（见下方 toolCalls 循环）。
          emitted = true;
          hooks.onActivity?.({ name: ev.toolName, input: ev.input, ...(ev.invalid ? { invalid: true } : {}) });
        }
      }
      const done = (await finished) || {};
      // finishReason=error：没有 error part 但 provider 明确以错误收尾——不当成功吞掉（归入可重试失败）
      if (done.finishReason === 'error') throw stepError('模型以错误结束（finishReason=error）', 'model_finish_error');
      return { done, text, retries: attempt - 1 };
    } catch (e) {
      if (e?.code === 'steer_preempt') throw e; // 抢占不是失败：不重试、不记 partialText（本轮本就无产出）
      const cls = classifyModelError(e, { aborted: Boolean(signal?.aborted) });
      const canRetry = cls.retryable && !emitted && attempt <= retry.maxRetries && !signal?.aborted;
      if (!canRetry) {
        if (text && e && typeof e === 'object') e.partialText = text; // 已产出文本交外层落账（不假装没发生）
        throw e;
      }
      const delayMs = nextRetryDelayMs(attempt, retry);
      logger.warn('agent-loop', '模型步失败，退避后重试', {
        attempt,
        maxRetries: retry.maxRetries,
        delayMs,
        kind: cls.kind,
        err: String(e?.message || e),
      });
      hooks.onRetry?.({ retry: attempt, max: retry.maxRetries, delayMs, kind: cls.kind, error: String(e?.message || e) });
      await sleepAbortable(delayMs, signal);
    } finally {
      clearTimeout(idleTimer);
      clearInterval(preemptTimer);
      signal?.removeEventListener?.('abort', onOuterAbort);
    }
  }
}

export async function runAgentLoop({ messages, modelRun, executeTool, maxSteps = Infinity, signal, retry }, hooks = {}) {
  const budget = Number.isFinite(Number(maxSteps)) && Number(maxSteps) > 0 ? Math.floor(Number(maxSteps)) : Infinity;
  const retryOpts = resolveRetryOptions(retry);
  const convo = Array.isArray(messages) ? messages.slice() : [];
  // 步边界插话（P1-10）：取走逻辑在入口（runs.js#consumeHeldMsgs 记 steer_consumed via='step'）。
  // 抢占要求两个 hooks 同时在位——只有 shouldPreempt 没有 takeSteerMessages 会无限抢占。
  const takeSteer = typeof hooks.takeSteerMessages === 'function' ? hooks.takeSteerMessages : null;
  const preemptEnabled = Boolean(takeSteer) && typeof hooks.shouldPreempt === 'function';
  /** 把持有中的插话按序并入对话（同步落检查点，续跑/压缩后都在）；返回注入条数 */
  const injectSteers = () => {
    if (!takeSteer) return 0;
    let msgs = null;
    try {
      msgs = takeSteer();
    } catch (e) {
      logger.warn('agent-loop', '插话取出失败（忽略，下个边界再试）', { err: e?.message || String(e) });
      return 0;
    }
    if (!Array.isArray(msgs) || !msgs.length) return 0;
    const batch = msgs.map((m) => ({
      role: 'user',
      content: String(m?.text ?? ''),
      // 附件元数据跟着插话一起进对话（图片内联在模型边界做，见 run-openai 的 prepareMessages）
      ...(Array.isArray(m?.attachments) && m.attachments.length ? { attachments: m.attachments } : {}),
    }));
    convo.push(...batch);
    hooks.onMessages?.(batch);
    logger.info('agent-loop', '已并入用户插话', { count: batch.length, ids: msgs.map((m) => m?.id ?? null) });
    return batch.length;
  };
  let lastText = '';
  let steps = 0;
  let lastFinishReason = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let wrappedUp = false;
  try {
    for (let step = 0; step < budget; step++) {
      if (signal?.aborted) break; // 用户中断：不再起新一步
      steps = step + 1;
      injectSteers(); // 步边界：上一步结束/抢占后到达的插话进模型视野（也覆盖首步前的判档窗口）
      let stepResult;
      try {
        stepResult = await runModelStep({ modelRun, messages: convo, signal, retry: retryOpts, hooks, preempt: preemptEnabled });
      } catch (e) {
        if (e?.code === 'steer_preempt') {
          // 抢占（P1-10）：本轮还没有任何可见产出就被切断——同一步号重来（不消耗步数），
          // 下一轮顶部 injectSteers() 把插话并入；journal 事实由 steer_consumed(via=step) 记录。
          logger.info('agent-loop', '插话抢占当前请求，同一步重来', { step: steps });
          step -= 1;
          continue;
        }
        // 失败尝试已产出的文本先落账再抛（模型以 error 收尾/断流时不吞掉用户已看到的文字）
        if (e?.partialText) lastText = e.partialText;
        throw e;
      }
      const { done, text: stepText } = stepResult;
      lastFinishReason = done.finishReason || '';
      if (done.usage && typeof done.usage === 'object') {
        inputTokens += Number(done.usage.inputTokens) || 0;
        outputTokens += Number(done.usage.outputTokens) || 0;
      }
      // 每步用量单独回调一次（顶栏「上下文使用率」靠它）：给的是**本步**的 tokens ——
      // 本步 inputTokens 才是「这次发出去的上下文有多大」，累计值只会越加越大、没有容量含义。
      if (done.usage && typeof done.usage === 'object') {
        hooks.onUsage?.({
          step: steps,
          inputTokens: Number(done.usage.inputTokens) || 0,
          outputTokens: Number(done.usage.outputTokens) || 0,
          totalTokens: Number(done.usage.totalTokens) || 0,
        });
      }
      // 每步留痕（排障用）：空回复、截断、工具风暴、重试次数都能从这里还原
      logger.info('agent-loop', '模型步完成', {
        step: steps,
        finishReason: lastFinishReason,
        textLen: stepText.length,
        toolCalls: Array.isArray(done.toolCalls) ? done.toolCalls.length : 0,
        inputTokens: done.usage?.inputTokens ?? null,
        outputTokens: done.usage?.outputTokens ?? null,
        retries: stepResult.retries,
      });
      if (stepText) lastText = stepText;
      // finishReason=error 的判定已移入 runModelStep（可重试失败；已产出文本经 partialText 落账）
      // 心跳：告诉看门狗「还活着」。没有它的话，工具执行超过静默阈值（15min）且期间无文本增量时，
      // lastProgressAt 不刷新 → run 被当成卡死而 abortRun，把正在正常干活的任务误杀。
      // 这个钩子 run-openai.js 一直有传，但此前全文没人调用。
      hooks.onPulse?.();
      if (Array.isArray(done.responseMessages)) {
        convo.push(...done.responseMessages);
        // 检查点钩子（P3）：把本步新增的消息批量交出去落盘——进程崩溃后从这里续，而不是从零重来
        hooks.onMessages?.(done.responseMessages);
      }
      if (done.finishReason !== 'tool-calls') {
        // 最终答复边界（P1-10）：用户已插话且预算还有余量 → 不结束 run，注入后继续答一轮；
        // 预算已尽则消息留在持有区，由 unsent 兜底（不静默消费）。
        if (step + 1 < budget && injectSteers() > 0) continue;
        break;
      }
      for (const call of done.toolCalls || []) {
        // AI SDK 已判定参数无效的调用（zod 不匹配 / JSON 解析失败 / 未知工具）：
        // 不执行、不追加结果——responseMessages 里 AI SDK 已自动放了 error 结果，
        // 再追加一条同 toolCallId 的结果会让下一轮请求因重复 tool-result 而畸形（或 400）。
        // 也不能走 canUseTool：为一个注定不执行的调用弹审批卡是纯噪音。
        if (call.invalid) continue;
        // 中断检查必须在**内层**也做：一轮可能返回多个 tool-call，用户在第 1 个执行中途点停止时，
        // 若不检查，后续 call 会 ① 命中 autoAllow 就真的执行（停止后的幽灵副作用），或
        // ② 走 canUseTool → askUser 新建 pending Promise，而 drainAsks 已经跑完且不会再跑
        //    → 该 Promise 永不 resolve → 本函数永不返回 → 上层 .finally(mcp.close) 永不执行
        //    → MCP stdio 子进程成孤儿。
        // 用 continue 而非 break：带 tool_calls 的 assistant 消息后，每个 toolCallId 都必须有
        // 对应结果，否则续跑时请求直接 400。中断也不能留半截。
        if (signal?.aborted) {
          const stoppedMsg = toToolResultMessage(call, { error: '已被用户停止' });
          convo.push(stoppedMsg);
          hooks.onMessages?.([stoppedMsg]); // 检查点：被跳过的调用也要落盘，会话保持良构
          continue;
        }
        const decision = hooks.canUseTool ? await hooks.canUseTool(call.toolName, call.input) : { behavior: 'allow' };
        let output;
        if (decision?.behavior === 'allow') {
          try {
            output = await executeTool(call.toolName, call.input);
          } catch (e) {
            output = { error: String(e?.message || e) };
          }
        } else {
          output = { error: decision?.message || '用户拒绝了该操作' };
        }
        const resultMsg = toToolResultMessage(call, output);
        convo.push(resultMsg);
        hooks.onMessages?.([resultMsg]); // 检查点：每条 tool 结果立即交出去落盘
        hooks.onPulse?.(); // 每个工具执行完也打一次：单个工具就可能跑很久
      }
    }
  } catch (e) {
    // 用户中断（abort）走静默收尾——终结由上层 stopRun 负责，不当失败上报
    if (signal?.aborted) return { result: lastText, messages: convo, aborted: true, steps, inputTokens, outputTokens };
    hooks.onResult?.({ subtype: 'error', is_error: true, result: lastText, error: String(e?.message || e), inputTokens, outputTokens, steps });
    throw e; // 让上层 .done.catch → failRun 广播失败（带消息）
  }
  if (signal?.aborted) return { result: lastText, messages: convo, aborted: true, steps, inputTokens, outputTokens };
  // 预算用尽且最后一步仍在要工具 → 强制收尾（OpenCode 式）：注入收尾指令再要一轮文字总结，
  // 不再静默截断（默认无上限时此分支不会走到）。
  const exhausted = steps >= budget && lastFinishReason === 'tool-calls';
  if (exhausted) {
    logger.warn('agent-loop', '工具步数上限已用尽，启动强制收尾', { maxSteps: budget, steps });
    try {
      const wrapConvo = [...convo, { role: 'system', content: WRAP_UP_PROMPT }];
      // 收尾轮走同一重试包装：forward:'text' —— 工具已禁用，即便模型仍返回 tool-call
      // 也一律忽略（不产生活动、不算已产出），绝不执行。
      const { done, text: wrapText, retries } = await runModelStep({
        modelRun,
        messages: wrapConvo,
        opts: { disableTools: true },
        signal,
        retry: retryOpts,
        hooks,
        forward: 'text',
      });
      if (done.usage && typeof done.usage === 'object') {
        inputTokens += Number(done.usage.inputTokens) || 0;
        outputTokens += Number(done.usage.outputTokens) || 0;
        // 收尾轮也是一次真实请求：同样上报（上下文只增不减，这里通常是最满的一次）
        hooks.onUsage?.({
          step: steps,
          inputTokens: Number(done.usage.inputTokens) || 0,
          outputTokens: Number(done.usage.outputTokens) || 0,
          totalTokens: Number(done.usage.totalTokens) || 0,
        });
      }
      logger.info('agent-loop', '强制收尾完成', {
        finishReason: done.finishReason || '',
        textLen: wrapText.length,
        inputTokens: done.usage?.inputTokens ?? null,
        outputTokens: done.usage?.outputTokens ?? null,
        retries,
      });
      if (Array.isArray(done.responseMessages)) {
        convo.push(...done.responseMessages);
        hooks.onMessages?.(done.responseMessages); // 收尾总结落检查点：历史不再停在半截 tool 结果
      }
      if (wrapText) lastText = wrapText;
      wrappedUp = true;
    } catch (e) {
      logger.warn('agent-loop', '强制收尾调用失败（按原状结束）', { err: e?.message || String(e) });
    }
  }
  hooks.onResult?.({ subtype: 'success', result: lastText, is_error: false, inputTokens, outputTokens, steps, exhausted, wrappedUp });
  return { result: lastText, messages: convo, steps, exhausted, wrappedUp, inputTokens, outputTokens };
}

/** 组一条 AI SDK 期望的 tool 结果消息（字符串→text，其余→json；对 ai@7 ToolResultPart 已核） */
export function toToolResultMessage(call, output) {
  const part = typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: output };
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: part }] };
}
