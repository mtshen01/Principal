/**
 * 动作执行插件 —— 配置驱动的通用动作（脚本 + 槽位填充，取代旧 data-cleanup）。
 * 业务代码就在本插件目录内（Phase 2 已物理搬迁）。
 *
 * P4（2026-10-09）：**对话意图路径退役**。同事侧动作执行改走 colleague-agent 的
 * `run_action` 工具（本目录 agent-tools.js 注册）；陌生人不再能靠关键词触发脚本
 * （拍板记录见 `docs/superpowers/specs/2026-10-09-colleague-agent-p4-design.md`）。
 * 欢迎卡片的快捷按钮路径（card-action.js）不受影响 —— 它是显式点击，本就不经意图识别。
 * `feature/index.js` 与槽位机/学习链文件留盘不删（card-action 直接调 handle；
 * 恢复意图路由只需把 feature 加回 features 数组，抄 tracking-stats 的先例）。
 */
// 副作用 import：模块加载即把 quick-action 的卡片回调处理器注册进 shared/card-actions 的表。
// 与 feishu-relay / feedback / task-notify 的做法一致。
import './card-action.js';
// 副作用 import：模块加载即把 run_action 注册进 capabilities/agent-tools.js 的工具注册表。
import './agent-tools.js';

export default {
  id: 'action-runner',
  // P4：意图 feature 退役（原为 [{ order: 30, feature: actionRunner }]）。
  // 留空数组而不是删掉 features 字段：装配层对空数组与缺字段一视同仁，但空数组能让
  // 「这里曾经挂着一个 feature」这件事在代码里可见 —— 与文件头注释互为印证。
  features: [],
};
