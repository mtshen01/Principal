# 「正在处理」表情标记的生命周期修正 · 设计（标记跟终态答复走）

> 状态：**已实现（2026-10-14）** ｜ 日期：2026-10-14 ｜ 前置：`2026-10-13-colleague-group-reply-design.md`
>
> 影响面：`src/shared/processing-mark.js`（新）+ 测试、`src/integrations/lark.js`、`src/channels/feishu.js`、`src/entrypoints/feishu/index.js`、`src/entrypoints/web/routes-requirements.js`、`src/plugins/colleague-agent/{feature,relay}.js`、`src/plugins/team-tools/feedback/index.js`、`src/plugins/tracking-stats/freeform.js`

## 一、背景与拍板记录

现状（问题）：机器人收到消息后会贴一个「正在处理」表情，但摘除绑在 `dispatchSafely` 返回上。
多个流程在 dispatch 返回后仍在干活（同事对话：飞书进程只中继几百毫秒，真跑 agent 的是 web 进程；
反馈：即时应答后还有后台分析/评审；数据查询：后台跑几十秒到几分钟）——
用户看到的是「表情出现一下就消失了，但机器人其实还在想」（2026-10-14 反馈）。

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 标记的语义 | **活在「这条消息引发的终态答复」上**，不跟 dispatch 返回走 |
| 2 | 摘除时机 | 答复发出后摘：同步流程 settle 即摘；进程内异步流程 `hold(promise)` 等延续落地；跨进程流程移交 web 在答复后摘 |
| 3 | 跨进程怎么摘 | 摘除凭据（被贴消息 id + reaction_id）随 relay payload 移交给 web，web 用**临时 client**（同 app 凭证）直接调删除 API；不做"web 通知飞书进程"的反向 IPC |
| 4 | 兜底 | 标记有 15 分钟上限（`MARK_MAX_MS`）：延续卡死 / 远端没摘走 → 强制摘除（移交形态静默，未移交形态 warn）。**只对 hold / transfer 形态武装**——同步流程的上限会把「跑了 20 分钟但仍在工作」的表情误摘，且旧行为本就没有上限 |
| 5 | 不做 | 不为「bot 下次开口」这类间接信号做全局 hook（跨进程不可知、隐式耦合重）；群聊多人协作仍不立项 |

## 二、机制（`shared/processing-mark.js`，纯逻辑 + 定时器注入）

```
createProcessingMark({ messageId, reactionId, release })
  ├─ hold(promise)   进程内异步延续：全部落地（含失败）后摘；可多次
  ├─ transfer()      摘除责任跨进程移交：本进程不再摘，只剩上限兜底
  └─ settle()        dispatch 返回后的收尾入口，返回的 promise 在「本进程对标记的处置完成」时 resolve
```

- `release` 由收信入口注入（`channel.removeReaction`，带 `{quiet}` 选项透传；约定不抛错）。
- 兜底上限在首次 `hold()` / `transfer()` 时武装、`unref`，正常释放时清掉；移交形态的上限触发走静默删除（远端多半已摘，逐条打日志是噪音）。

## 三、三条链路的接法

| 链路 | 形态 | 落点 |
|---|---|---|
| 同步流程（claude-exec / 材料池 / 评审卡片等） | `settle()` 即摘 | 入口行为不变 |
| 反馈的后台分析 / 评审流 | `hold(...)` | `feedback/index.js#handle`（轻度=闭环回复后，中/完全=评审结论后） |
| 数据查询的后台分析 | `hold(...)` | `tracking-stats/freeform.js#handle`；`startFreeformQuery` 新增返回 `done`（完成承诺） |
| 跨进程同事对话 | `transfer()` | `colleague-agent/feature.js` 接管即移交；凭据走 relay → `/api/req/colleague-agent/turn` → `routes-requirements.js#clearProcessingMark` 在本轮结束（agent 回复 / 委托步进结束）后摘 |

## 四、失败语义

| 失败点 | 行为 |
|---|---|
| web 侧摘除失败（reaction 已不存在 / 网络） | `removeReactionWithCreds` 记 warn、返回 false；不影响本轮结论 |
| web 进程崩溃 / 没收到请求 | 飞书侧 15 分钟上限兜底摘除（静默） |
| `hold` 的延续 reject | 视同落地（失败原因由延续自己的 catch 回告），标记不陪葬 |
| 延续永远不落地 | 上限触发：warn + 强制摘除（可观测） |
| 没贴上表情（reaction_id 为空） | 全流程 no-op（`release=null`），不影响任何分支 |

## 五、测试与门禁

- `shared/processing-mark.test.js`：四种形态 + release 只发一次 + 幂等 + 上限 + 无 release。
- `entrypoints/web/routes-requirements.test.js`：本轮结束后 `clearMark` 调用（成功/抛错/委托截获三分支）、payload 透传。
- `colleague-agent/{feature,relay}.test.js`：transfer 时机（接管才移交）、凭据透传与空串归一。
- `team-tools/feedback/index.test.js`（新）：轻度/完全托管的 hold；无标记渠道 no-op。分析/评审/系统通知经 deps 注入（真实调用要 LLM，`systemNotify` 在 Windows 会真的弹 Toast）。
- `tracking-stats/freeform.test.js`（新）：查询 hold `done`、限流不 hold、只发前缀不启动。
- 门禁：`npm test` 全绿；无前端改动，不涉及 e2e。

## 六、已知边界

- 同事对话里 `tracking_report` 工具的后台结果不延展标记（agent 已回复，标记随 agent 轮结束摘除；数据报告是后续独立消息）。
- bug-patrol / 预留的 owner 长任务命令若日后改成 fire-and-forget，需要按第三种形态接一次 hold（机制已就绪，一行）。
- 移交后的摘除依赖 web 进程活着；web 崩溃时靠飞书侧上限兜底（最多挂 15 分钟）。
