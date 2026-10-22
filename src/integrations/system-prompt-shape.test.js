/**
 * 防回归守卫：Claude Agent SDK 的 systemPrompt 只认
 *   - { type:'preset', preset:'claude_code', append }
 *   - { type:'custom', prompt }          ← 字段名必须是 prompt
 *
 * 历史上 12+ 处写成 { type:'custom', content } / { type:'custom', custom }：
 * SDK 读取 s.prompt 得 undefined，整段角色提示被**静默丢弃**（不报错、不告警），
 * 排查成本极高（2026-10-10 全量修复）。本测试静态扫描 src，再出现旧字段名立即失败。
 *
 * 只扫描非测试的 .js；旧写法示例只允许出现在注释里且不带字段冒号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

test('systemPrompt 不得使用 SDK 不读的 custom/content 字段名', () => {
  const bad = [];
  for (const file of walk(SRC_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/type:\s*'custom'/.test(lines[i])) continue;
      // type 声明同行或随后 3 行内出现 custom:/content: 字段 → 旧写法
      const window = lines.slice(i, i + 4).join(' ');
      if (/\b(custom|content)\s*:/.test(window)) {
        bad.push(`${path.relative(SRC_ROOT, file)}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(bad, [], `systemPrompt 使用了 SDK 不读的字段名（应为 prompt）：\n${bad.join('\n')}`);
});
