/**
 * MCP 工具入参的轻量 JSON Schema 校验（2026-10-11 补缺口：「MCP 的 JSON Schema 参数类型不被校验」）。
 *
 * 背景：openai 路径的工具入参校验只认 zod 形态的 inputSchema（AI SDK 语义，见
 * `openai-compat-model.js` 的 `tool-call` 注释）；MCP 工具经 `@ai-sdk/mcp` 带来的是原始
 * JSON Schema，坏参会直接送到 server——server 不校验时可能执行脏副作用，校验时也只回报
 * 含糊的协议错误。这里在 `mcp.executeTool` 入口做一层**确定性**防御。
 *
 * 支持子集（宁漏勿误杀：判不了的形状一律放行，交 server 兜底）：
 *   - `type`：string/number/integer/boolean/object/array/null，含联合数组
 *   - `required` / `properties` 递归 / `items` 递归（单 schema 或 tuple 数组）
 *   - 出现 `anyOf`/`oneOf`/`allOf`/`$ref`/`not`/`if` 的层级整体跳过（语义太活，不猜）
 * 不判：`enum`/`const`/`pattern`/`format`/长度与数值区间/`additionalProperties`。
 */

const MAX_ERRORS = 5; // 报给模型的错误条数上限（超出只计数省略）
const MAX_DEPTH = 8; // 递归深度上限（病态 schema 防御；超限即停 = 宁漏勿误杀）
/** 出现即整层跳过判定的关键字：语义依赖外部上下文，静态判不了 */
const UNJUDGEABLE_KEYS = Object.freeze(['anyOf', 'oneOf', 'allOf', '$ref', 'not', 'if']);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JS 值的 JSON 类型名（报错文案用） */
function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 单个 JSON Schema type 与值的匹配（未知 type 放行） */
function matchesType(type, v) {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    default:
      return true;
  }
}

/**
 * 从 AI SDK 的 Schema 包装里取出裸 JSON Schema。
 * `@ai-sdk/mcp` 的 `client.tools()` 给的是 AI SDK Schema 实例（实测：`{ _type:'json', jsonSchema, validate }`）——
 * 裸对象/未知形态原样返回（校验器判不了会跳过，交 server 兜底）。
 * @param {unknown} schema
 * @returns {unknown} 裸 JSON Schema（或原值）
 */
export function unwrapJsonSchema(schema) {
  if (isPlainObject(schema) && isPlainObject(schema.jsonSchema)) return schema.jsonSchema;
  return schema;
}

/**
 * 校验模型入参是否符合 MCP 工具的 JSON Schema（支持子集，见文件头）。
 * @param {unknown} schema 工具声明的 inputSchema（裸 JSON Schema；AI SDK 包装请先 `unwrapJsonSchema`）
 * @param {unknown} input 模型给出的入参
 * @returns {{ok:true} | {ok:false, errors:string[]}} errors 为人类/模型可读中文消息（至多 5 条）
 */
export function validateToolInput(schema, input) {
  const errors = [];
  walk(schema, input, '', 0, errors);
  if (!errors.length) return { ok: true };
  return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
}

function walk(schema, value, path, depth, errors) {
  if (errors.length >= MAX_ERRORS || depth > MAX_DEPTH) return;
  if (!isPlainObject(schema)) return;
  if (UNJUDGEABLE_KEYS.some((k) => k in schema)) return;

  const types = Array.isArray(schema.type) ? schema.type : schema.type != null ? [schema.type] : [];
  if (types.length && !types.some((t) => matchesType(t, value))) {
    errors.push(`入参${path ? ` ${path}` : '本身'} 类型应为 ${types.join('/')}，实际为 ${jsonTypeOf(value)}`);
    return; // 类型不符：子结构不再逐个报错（噪音）
  }

  if (isPlainObject(value)) {
    // required 只对对象生效（JSON Schema 语义）；非对象值配 required 判不了 → 放行
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && !Object.hasOwn(value, key)) {
        errors.push(`缺少必填参数 ${path ? `${path}.` : ''}${key}`);
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, key)) walk(sub, value[key], path ? `${path}.${key}` : key, depth + 1, errors);
      }
    }
  } else if (Array.isArray(value)) {
    if (Array.isArray(schema.items)) {
      // tuple 形态：逐个 schema 对应索引
      const n = Math.min(value.length, schema.items.length);
      for (let i = 0; i < n; i++) walk(schema.items[i], value[i], `${path}[${i}]`, depth + 1, errors);
    } else if (isPlainObject(schema.items)) {
      for (let i = 0; i < value.length; i++) walk(schema.items, value[i], `${path}[${i}]`, depth + 1, errors);
    }
  }
}
