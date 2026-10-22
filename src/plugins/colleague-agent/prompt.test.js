import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, formatRequirementLine } from './prompt.js';

test('formatRequirementLine：带 id / 标题 / 阶段', () => {
  const line = formatRequirementLine({ id: 'r_a1', title: '订单列表改版', phase: 'dev' });
  assert.match(line, /r_a1/);
  assert.match(line, /订单列表改版/);
  assert.match(line, /开发期/);
});

test('buildSystemPrompt：写明对方是谁、什么职位', () => {
  const p = buildSystemPrompt({
    colleague: { id: 'cl_1', name: '张三' },
    roleLabel: '后端',
    requirements: [],
  });
  assert.match(p, /张三/);
  assert.match(p, /后端/);
});

// 2026-10-13：群聊里问的，答复发进群（多人可见）—— prompt 必须如实告知语境，
// 否则模型按「私聊」的口气组织措辞，和实际可见性对不上
test('buildSystemPrompt：群聊来源写明「回复发进群、其他人可见」；私聊仍写私聊', () => {
  const group = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', chatType: 'group' });
  assert.match(group, /群/);
  assert.match(group, /发进这个群|可见/, '要明说答复进群、多人可见');

  const p2p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', chatType: 'p2p' });
  assert.match(p2p, /私聊/);
  assert.doesNotMatch(p2p, /发进这个群/);
});

test('buildSystemPrompt：列出他参与的需求，便于 agent 判归属', () => {
  const p = buildSystemPrompt({
    colleague: { id: 'cl_1', name: '张三' },
    roleLabel: '后端',
    requirements: [{ id: 'r_a1', title: '订单列表改版', phase: 'dev' }],
  });
  assert.match(p, /r_a1/);
  assert.match(p, /订单列表改版/);
});

test('buildSystemPrompt：没有需求时给出明确说明，不留空白让模型瞎编', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /暂时没有/);
});

// —— 这条 policy 是整个 2.0 相对旧分类器管线的核心增量：
// 没有它，agent 说「你这份文档和代码对不上」只能是瞎猜。
test('buildSystemPrompt：含「先查证再质疑」硬约束', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /查证/);
  assert.match(p, /read_project_code/);
});

test('buildSystemPrompt：含「不替主机做承诺」与「阶段流转不归你管」两条边界', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /排期|优先级|承诺/);
  assert.match(p, /阶段/);
});

// —— P4：可用动作清单 + 工具选择指引

test('buildSystemPrompt：有动作时注入清单与 run_action 确认制', () => {
  const p = buildSystemPrompt({
    colleague: { id: 'cl_1', name: '张三' },
    roleLabel: '运营',
    requirements: [],
    actions: [{ id: 'ac_1', name: '清数据', description: '清指定环境', variables: [] }],
  });
  assert.match(p, /可用动作/);
  assert.match(p, /ac_1/);
  assert.match(p, /清数据/);
  assert.match(p, /run_action/);
  assert.match(p, /确认/, '确认制必须写进 prompt（软约束的第二处）');
});

test('buildSystemPrompt：没有动作时明确说明「没配」，不留空白让模型瞎编', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '运营', requirements: [], actions: [] });
  assert.match(p, /没有配置任何可执行动作/);
});

test('buildSystemPrompt：含「追问后短回复要认」的追问闭环约束（P4 加固）', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /短回复|短词/);
  assert.match(p, /别名/);
});

test('buildSystemPrompt：新工具的选择指引齐全（report_bug / submit_req_change / supplement_requirement / upload_design_ref / tracking_report / notify_host）', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '产品', requirements: [] });
  for (const t of ['report_bug', 'submit_req_change', 'supplement_requirement', 'upload_design_ref', 'tracking_report', 'notify_host']) {
    assert.match(p, new RegExp(t), t);
  }
});
