/**
 * 上下文压缩纯函数单测（T7）：切点边界安全 / 触发口径 / 转录格式化 / 滚动摘要 prompt / system 组装。
 * 切点与序列合法性是「可能直接 400」的防线，正反例都要钉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_TRIGGER,
  COMPACT_KEEP_RECENT,
  COMPACT_KEEP_MIN,
  COMPACT_MIN_DROP,
  MAX_SUMMARY_CHARS,
  SUMMARY_SECTIONS,
  SUMMARY_SYSTEM_PROMPT,
  shouldCompact,
  pickCompactCut,
  resolveKeepRecent,
  formatMessagesForSummary,
  buildSummaryPrompt,
  normalizeSummaryText,
  composeSystemWithSummary,
} from './conv-compact.logic.js';

const user = (t = 'u') => ({ role: 'user', content: t });
const asst = (t = 'a') => ({ role: 'assistant', content: t });
const tool = (t = 'tool-out') => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: t } }] });

test('shouldCompact：模型可见长度（总−已覆盖）超阈值才触发', () => {
  assert.equal(shouldCompact({ total: COMPACT_TRIGGER }), false);
  assert.equal(shouldCompact({ total: COMPACT_TRIGGER + 1 }), true);
  assert.equal(shouldCompact({ total: 500, covered: 300 }), false, '已覆盖部分不计入可见长度');
  assert.equal(shouldCompact({ total: 500, covered: 200 }), true);
  assert.equal(shouldCompact({}), false);
});

test('pickCompactCut：保留段从 user 边界开始（不切 tool 序列）；下限与 minDrop 双重约束', () => {
  // 260 条：交替 user/assistant；切点 = 最近 ≤ 260-100=160 的 user
  const msgs = Array.from({ length: 260 }, (_, i) => (i % 2 ? asst('a' + i) : user('u' + i)));
  const cut = pickCompactCut(msgs, {});
  assert.ok(cut > 0 && cut <= 160);
  assert.equal(msgs[cut].role, 'user', '切点必须是整轮边界');
  assert.ok(cut >= COMPACT_MIN_DROP);

  // 保留段尾部是 tool 序列：从 maxCut 向前回退到最近的 user
  const withTail = [...msgs.slice(0, 150), user('u150'), asst('a151'), tool(), tool(), tool(), tool(), tool()];
  const cut2 = pickCompactCut(withTail, {});
  assert.equal(withTail[cut2].role, 'user');

  // 找不到 user 边界（全是 assistant/tool）→ -1
  assert.equal(pickCompactCut([...Array.from({ length: 250 }, () => asst()), tool()], {}), -1);
  // 新丢条数不足 minDrop → -1
  assert.equal(pickCompactCut(msgs, { covered: cut - (COMPACT_MIN_DROP - 1) }), -1, '新增可丢太少不压');
  // 长度不足 keepRecent → -1
  assert.equal(pickCompactCut(Array.from({ length: 50 }, () => user()), {}), -1);
  // covered 已越过 maxCut（视图很短）→ -1 或安全切点，不得小于 covered
  const late = pickCompactCut(msgs, { covered: 159 });
  assert.ok(late === -1 || late >= 159);
});

test('formatMessagesForSummary：角色标签、tool 输出提取、单条与总量截断', () => {
  const msgs = [
    user('把按钮改蓝'),
    asst([{ type: 'text', text: '好的' }, { type: 'tool-call', toolName: 'Edit', input: { file_path: 'a.vue' } }]),
    tool('已编辑 a.vue'),
    { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
  ];
  const text = formatMessagesForSummary(msgs, { perMessageChars: 100, budgetChars: 500 });
  assert.match(text, /【用户】把按钮改蓝/);
  assert.match(text, /\[调用 Edit\]/);
  assert.match(text, /【工具结果】\[结果\] 已编辑 a\.vue/);
  assert.ok(text.length <= 600, `总量应被截断：${text.length}`);

  assert.equal(formatMessagesForSummary([]), '');
  assert.equal(formatMessagesForSummary(null), '');
});

test('resolveKeepRecent：轻消息取 maxKeep；重消息按 token 预算收缩；不低于 minKeep', () => {
  // 轻消息：返回 min(maxKeep, 全量长度)
  const light = Array.from({ length: 150 }, (_, i) => user('u' + i));
  assert.equal(resolveKeepRecent(light), COMPACT_KEEP_RECENT);
  assert.equal(resolveKeepRecent(light.slice(0, 30)), 30, '不足 maxKeep 时返回实际长度');
  assert.equal(resolveKeepRecent([]), 1, '空数组兜底 1（切点侧会兜 -1）');

  // 重消息：每条 3804 字节 → 951 token；预算 20000 → 951×22 越过预算即停在 22 条
  const heavy = Array.from({ length: 60 }, (_, i) => user('x'.repeat(3800) + String(i).padStart(4, '0')));
  assert.equal(resolveKeepRecent(heavy), 22, '越过预算的那条保留，下一条起不再要');

  // 超重消息：不低于 minKeep 条（近期上下文优先于预算）
  const superHeavy = Array.from({ length: 100 }, () => user('y'.repeat(400_000)));
  assert.equal(resolveKeepRecent(superHeavy), COMPACT_KEEP_MIN);

  // maxKeep 是可配上限（先到者停）
  assert.equal(resolveKeepRecent(light, { maxKeep: 10 }), 10);
  assert.equal(resolveKeepRecent(superHeavy, { maxKeep: 5 }), 5);
});

test('四要素摘要（P0）：system 与 prompt 固定「进度/约束/待办/数据」四节', () => {
  assert.deepEqual(SUMMARY_SECTIONS, ['【进度与决策】', '【约束与偏好】', '【待办与下一步】', '【关键数据】']);
  for (const s of SUMMARY_SECTIONS) assert.ok(SUMMARY_SYSTEM_PROMPT.includes(s), `system 应含 ${s}`);
  const p = buildSummaryPrompt({ droppedText: 'x' });
  for (const s of SUMMARY_SECTIONS) assert.ok(p.includes(s), `prompt 应含 ${s}`);
});

test('buildSummaryPrompt：旧摘要参与滚动合并；输出单一摘要的指令在场', () => {
  const p = buildSummaryPrompt({ previousSummary: '早前：用户在改登录', droppedText: '【用户】现在改支付' });
  assert.match(p, /【已有摘要（覆盖更早的对话）】[\s\S]*改登录/);
  assert.match(p, /【新增需要并入摘要的对话】[\s\S]*改支付/);
  assert.match(p, /单一摘要/);

  const only = buildSummaryPrompt({ droppedText: 'x' });
  assert.ok(!only.includes('已有摘要'));
});

test('normalizeSummaryText / composeSystemWithSummary：截断与 system 挂载；空摘要不产生空段', () => {
  const long = normalizeSummaryText('x'.repeat(MAX_SUMMARY_CHARS + 100));
  assert.ok(long.length <= MAX_SUMMARY_CHARS + 40, '超长摘要被头尾截断');
  assert.match(long, /略 \d+ 字符/);

  const sys = composeSystemWithSummary('主提示词', ' 要点一\n要点二 ');
  assert.match(sys, /^主提示词\n\n## 历史摘要/);
  assert.match(sys, /要点一/);
  assert.equal(composeSystemWithSummary('主提示词', ''), '主提示词', '无摘要时原样返回');
  assert.equal(composeSystemWithSummary('主提示词', null), '主提示词');
});
