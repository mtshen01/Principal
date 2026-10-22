/**
 * 模型强度（effort）与 Ultracode 的纯逻辑 —— 零 DOM，供 chat.js 调用、node --test 直测。
 *
 * 两套档位（spec `2026-10-08-composer-bar-and-effort-design.md`）：
 *  - Claude：SDK EffortLevel 五档（low/medium/high/xhigh/max，与设置页选单对齐）+
 *    Ultracode 作最高一档（选中 = 开编排 + 强制 xhigh）；
 *  - 自定义（openai-compat）：档位来自 `/models` 的 effort 元数据（supported_levels），
 *    外加「关闭思考」(none)，**末尾同样有 Ultracode**（编排能力见 capabilities/workflow.logic.js：
 *    服务端在开了编排的那一轮才把 Workflow 工具交给模型）。
 *  自定义模型的选中值经 `reasoning_effort` 透传到请求；Ultracode 不是厂商档位，
 *  开了它**不改变**当前 effort（各家档位语义自拟，硬映射到某一档是猜）。
 */

export const CLAUDE_PROVIDER = 'claude-agent';
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** 自定义模型的「关闭思考」值（DeepSeek 语义：reasoning_effort=none 关闭 thinking） */
export const EFFORT_OFF = 'none';
/** Ultracode 档的哨兵值（不是真实 effort；选中后果见 applyEffortChoice） */
export const ULTRACODE = 'ultracode';

const LABELS = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: 'Max',
  none: '关闭思考',
  [ULTRACODE]: '✨ Ultracode',
};

/** 档位中文标签；未知值原样显示（不同厂商可能返回自定义档名） */
export function effortLabel(value) {
  return LABELS[value] || String(value ?? '');
}

/** 档位的一句话说明（强度面板的描述行） */
const DESCS = {
  [EFFORT_OFF]: '不进行深度思考',
  low: '更快',
  medium: '平衡',
  high: '深思',
  xhigh: '极深',
  max: '最强',
  [ULTRACODE]: '多智能体编排',
};

/** 档位描述；未知值返回空串（不同厂商可能返回自定义档名） */
export function effortDesc(value) {
  return DESCS[value] || '';
}

/** 刻度上的短标签：Ultracode 只留 ✨ —— 档位多、横向空间紧 */
export function effortTickLabel(value) {
  return value === ULTRACODE ? '✨' : effortLabel(value);
}

/**
 * 当前模型的强度档位列表（末尾恒为 Ultracode 行）。
 * Ultracode 排在厂商档位之后而不是参进排序：它是**编排开关**，与思考档位正交，
 * 所以没有 effort 元数据的模型也照样给（否则这类模型永远够不到编排）。
 * @param {{provider?:string, efforts?:string[]}} p
 * @returns {string[]} 只有 Ultracode 一项 = 该模型没有思考档位，但仍可开编排
 */
export function effortOptions({ provider, efforts = [] } = {}) {
  if (provider === CLAUDE_PROVIDER) return [...CLAUDE_EFFORTS, ULTRACODE];
  const list = (Array.isArray(efforts) ? efforts : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  return [...(list.length ? [EFFORT_OFF, ...list] : []), ULTRACODE];
}

/**
 * 选一个可用的档位：当前值合法则保留；否则自定义模型落 defaultEffort/第一档、Claude 落 medium。
 * 模型无档位时原样保留当前值（控件置灰，发送时 chat.js 不带 effort）。
 */
export function pickEffort({ provider, efforts = [], defaultEffort = '', current = '' } = {}) {
  const opts = effortOptions({ provider, efforts });
  if (!opts.length) return current;
  // Ultracode **不作档位返回**：它是编排开关（chatUltracode 那个布尔量），一旦被当成 effort 写回，
  // 就会作为 reasoning_effort=ultracode 发给服务商（必然 400）。从老会话记录里读到它时按非法值回落。
  if (current && current !== ULTRACODE && opts.includes(current)) return current;
  if (provider === CLAUDE_PROVIDER) return 'medium';
  if (defaultEffort && opts.includes(defaultEffort)) return defaultEffort;
  // 无默认档：优先真实思考档（none=关闭思考不该成为托管默认，Ultracode 更不该——
  // 它是编排开关，把它当默认会让每条消息都去拉一批子代理烧额度）；都没有就不指定。
  return opts.find((v) => v !== EFFORT_OFF && v !== ULTRACODE) || '';
}

/** 值是否对当前模型合法（会话还原时用它校验持久化的 effort） */
export function isEffortValid(value, { provider, efforts = [] } = {}) {
  return effortOptions({ provider, efforts }).includes(value);
}

/**
 * 选中某档的后果：Ultracode 档 = 开编排 + 强制「极高（xhigh）」；其余档关闭编排。
 * 强制 xhigh 只对 Claude 成立（xhigh 是 SDK 档位）；自定义模型的调用方**不要**用这里的 effort 值，
 * 见 chat.js 的落档处：那边保持用户原来选的厂商档位。
 * @returns {{effort:string, ultracode:boolean}}
 */
export function applyEffortChoice(value) {
  if (value === ULTRACODE) return { effort: 'xhigh', ultracode: true };
  return { effort: value, ultracode: false };
}

/** 该模型的 Ultracode 是否可用：编排工具（Workflow）被用户全局禁用时，这一档不可达 */
export function ultracodeBlocked(disabledTools) {
  return Array.isArray(disabledTools) && disabledTools.includes('Workflow');
}

/**
 * 校准自定义凭证的归属（启动、还原会话、打开模型弹层都要走同一套）。
 *
 * 为什么它属于「强度」那一层：自定义模型的档位元数据挂在**凭证下的模型条目**上
 * （`currentModelEfforts` 要 `credId` + `model` 双命中）。认不到凭证 → 档位查不到 →
 * 强度控件只能显示「—」（看起来是空的）。所以认领这件事是强度控件能否出档的前置条件，
 * 不能只在「打开模型选择」时才做一次。
 *
 * 规则（顺序即优先级）：
 *  1. credId 命中 → 就用它（`claimed:false`）；
 *  2. credId 有值但查不到（凭证被删）→ null（**不**漂移到别的凭证，否则请求会配上别人的 key/baseURL）；
 *  3. credId 为空（老用户此前不存 id）→ 按 model 在这批凭证里**唯一**认领一次；
 *     多条凭证有同名模型时无法判定归属，返回 null（宁可不认，也不串台）。
 * @param {{creds?:Array, credId?:string, model?:string}} p
 * @returns {{id:string, claimed:boolean}|null} null = 认不到，调用方回落 Claude
 */
export function rehomeCustomCred({ creds = [], credId = '', model = '' } = {}) {
  const list = (Array.isArray(creds) ? creds : []).filter((c) => c && c.id);
  if (credId) {
    const hit = list.find((c) => c.id === credId);
    return hit ? { id: hit.id, claimed: false } : null;
  }
  const owners = list.filter((c) =>
    (Array.isArray(c.models) ? c.models : []).some((m) => m && m.id === model),
  );
  return owners.length === 1 ? { id: owners[0].id, claimed: true } : null;
}
