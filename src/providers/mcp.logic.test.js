/**
 * MCP 入参轻校验单测（2026-10-11 补缺口）：类型/必填/递归/跳过语义/截断与健壮性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolInput, unwrapJsonSchema } from './mcp.logic.js';

const OBJ = (props, required = []) => ({ type: 'object', properties: props, required });

test('unwrapJsonSchema：剥 AI SDK Schema 包装；裸对象/未知形态原样返回', () => {
  const raw = OBJ({ text: { type: 'string' } }, ['text']);
  assert.equal(unwrapJsonSchema({ _type: 'json', jsonSchema: raw, validate: undefined }), raw);
  assert.equal(unwrapJsonSchema(raw), raw);
  assert.equal(unwrapJsonSchema(null), null);
  assert.equal(unwrapJsonSchema('x'), 'x');
});

test('类型匹配放行（含联合类型、integer/number 语义、additionalProperties 不判）', () => {
  assert.deepEqual(validateToolInput(OBJ({ text: { type: 'string' } }, ['text']), { text: 'hi' }), { ok: true });
  assert.deepEqual(validateToolInput({ type: ['string', 'null'] }, null), { ok: true });
  assert.deepEqual(validateToolInput({ type: ['string', 'null'] }, 'x'), { ok: true });
  assert.deepEqual(validateToolInput({ type: 'integer' }, 5), { ok: true });
  const nonInt = validateToolInput({ type: 'integer' }, 5.5);
  assert.equal(nonInt.ok, false, 'integer 不收小数');
  assert.match(nonInt.errors[0], /类型应为 integer，实际为 number/);
  assert.deepEqual(validateToolInput({ type: 'number' }, 5.5), { ok: true });
  assert.deepEqual(validateToolInput({ type: 'object', additionalProperties: true }, { any: 1 }), { ok: true });
});

test('抓类型不匹配（2026-09-30 实测的 {path:123} 形态）', () => {
  const r = validateToolInput(OBJ({ path: { type: 'string' } }, ['path']), { path: 123 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /入参 path 类型应为 string，实际为 number/);
});

test('抓缺必填 + 嵌套对象/数组元素递归', () => {
  const schema = OBJ(
    {
      options: { type: 'array', items: OBJ({ label: { type: 'string' }, n: { type: 'integer' } }, ['label']) },
      nested: { type: 'object', properties: { flag: { type: 'boolean' } }, required: ['flag'] },
    },
    ['command'],
  );
  const r = validateToolInput(schema, { options: [{ label: 'a', n: 1 }, { label: 7 }], nested: {} });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    '缺少必填参数 command',
    '入参 options[1].label 类型应为 string，实际为 number',
    '缺少必填参数 nested.flag',
  ]);
});

test('根级类型不符：报「入参本身」且不深入子结构', () => {
  const r = validateToolInput(OBJ({ x: { type: 'string' } }, ['x']), [1]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['入参本身 类型应为 object，实际为 array']);
});

test('判不了的层级整体跳过（anyOf/$ref），不误杀', () => {
  assert.deepEqual(validateToolInput({ anyOf: [{ type: 'string' }, { type: 'number' }] }, true), { ok: true });
  assert.deepEqual(validateToolInput({ $ref: '#/defs/x', type: 'string' }, 42), { ok: true });
  // 无 type 的对象 schema：仍查 required；非对象值配 required → 不适用放行
  const r = validateToolInput({ required: ['x'] }, {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /缺少必填参数 x/);
  assert.deepEqual(validateToolInput({ required: ['x'] }, 'str'), { ok: true });
});

test('错误截断到 5 条；畸形 schema / 深嵌套不炸', () => {
  const r = validateToolInput({ type: 'object', required: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 5, '至多报 5 条');
  // 畸形/布尔 schema 一律放行
  assert.deepEqual(validateToolInput(null, 'x'), { ok: true });
  assert.deepEqual(validateToolInput(true, 'x'), { ok: true });
  assert.deepEqual(validateToolInput('nope', 'x'), { ok: true });
  // 深嵌套：超过深度上限即停（宁漏勿误杀，重要的是不炸）
  let deepSchema = { type: 'string' };
  let deepValue = 123;
  for (let i = 0; i < 20; i++) {
    deepSchema = { type: 'object', properties: { x: deepSchema } };
    deepValue = { x: deepValue };
  }
  assert.deepEqual(validateToolInput(deepSchema, deepValue), { ok: true });
});
