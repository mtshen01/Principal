/**
 * run-openai 纯函数层单测：工具循环步数上限归一。
 * 悬空工具调用修复用例已随 P0-③ 迁至 `capabilities/context-normalize.logic.test.js`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMaxSteps } from './run-openai.logic.js';

test('resolveMaxSteps：正整数生效取整；0/空/非法 = Infinity（无上限，同 Claude Code / OpenCode 默认）', () => {
  assert.equal(resolveMaxSteps(5), 5);
  assert.equal(resolveMaxSteps('50'), 50);
  assert.equal(resolveMaxSteps(2.9), 2);
  assert.equal(resolveMaxSteps(0), Infinity);
  assert.equal(resolveMaxSteps('0'), Infinity);
  assert.equal(resolveMaxSteps(''), Infinity);
  assert.equal(resolveMaxSteps(null), Infinity);
  assert.equal(resolveMaxSteps(undefined), Infinity);
  assert.equal(resolveMaxSteps('abc'), Infinity);
  assert.equal(resolveMaxSteps(-3), Infinity);
  assert.equal(resolveMaxSteps(Infinity), Infinity, '显式 Infinity 仍是 Infinity（不因 >0 判定被截）');
});
