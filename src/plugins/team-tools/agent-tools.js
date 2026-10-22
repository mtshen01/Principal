/**
 * `report_bug` —— 同事对话 agent 的故障登记入口（P4）。
 *
 * 语义按拍板 #1：**直入自动开发**。同事（名册内）报的故障 → `createTask(type:'bug')`
 * → `requestAutoDevelop` 进自动开发队列；开发完成仍由主机确认合并（auto-dev 的既有闸）。
 * 撤销走 `discard-task`（见 `entrypoints/web/undo-agent-action.js` 的状态机）。
 *
 * 为什么不经 feedback 的托管/评审流：2.0 的授权模型是「乐观执行 + 可撤销」，
 * 与 start_dev_task 同一取向；且任务全程落任务面板，主机事后可见、可放弃。
 */
import { z } from 'zod';
import { registerAgentTool } from '../../capabilities/agent-tools.js';
import { createTask as realCreateTask } from '../../store/tasks.js';
import { requestAutoDevelop as realRequestAutoDevelop } from './auto-dev/queue.js';

export const REPORT_BUG = 'report_bug';

/**
 * 构造工具定义（导出供单测注入替身；模块加载时用默认真实依赖注册）。
 * @param {object} [deps] { createTask, requestAutoDevelop }
 */
export function buildReportBugTool(deps = {}) {
  const createTask = deps.createTask || realCreateTask;
  const requestAutoDevelop = deps.requestAutoDevelop || realRequestAutoDevelop;

  return {
    name: REPORT_BUG,
    description:
      '把同事报告的故障（报错、白屏、行为不对等软件异常）登记进系统并立即安排自动开发修复。' +
      '只在同事描述的是「故障」时用；需求/改进找 submit_req_change，接口文档找 register_api_doc。' +
      '描述尽量保留同事原话：现象、复现步骤、环境。',
    danger: 'reversible',
    roles: ['*'],
    schema: {
      bug: z.string().describe('故障描述（同事原话：现象、复现步骤、环境）'),
    },
    handler: async ({ bug }, ctx) => {
      const detail = String(bug || '').trim();
      if (!detail) return { error: '故障描述不能为空，先把同事说的现象记下来' };

      const task = createTask({
        type: 'bug',
        title: detail.slice(0, 40),
        detail,
        // 与 feedback 的 source 同形：openId 是提交人，via 标来源，chatId 供后续回发用
        source: { openId: ctx?.openId || '', via: 'feishu', chatId: ctx?.chatId || '' },
      });
      if (!task?.id) return { error: '登记失败，请稍后再试' };

      requestAutoDevelop(task.id, '同事对话提交');
      return {
        ok: true,
        reply: `已把故障登记为「${task.title}」并进入自动开发队列，修好后会通知你。`,
        // 撤销锚点：taskId 模型不需要、也不该复述（stripPrivate 会剥掉）
        __private: { taskId: task.id },
      };
    },
    buildUndo: (_input, result) => ({ kind: 'discard-task', taskId: result?.__private?.taskId || null }),
  };
}

// 模块加载即注册（插件停用 → 本文件不被 import → 工具自然缺席）
registerAgentTool(buildReportBugTool());
