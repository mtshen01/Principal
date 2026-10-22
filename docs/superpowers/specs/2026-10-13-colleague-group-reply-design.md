# 同事对话群聊回复路由 · 设计（群里问的答复回群里）

> 状态：**已实现（2026-10-13）** ｜ 日期：2026-10-13 ｜ 前置：`2026-09-22-colleague-agent-design.md`（2.0）、P4/P5 已完成
>
> 影响面：`src/shared/reply-target.js`（新）+ 测试、`src/integrations/lark.js`（新增两个发送原语）、`src/plugins/colleague-agent/`（session / feature / relay / prompt / tools/req-write）、`src/plugins/tracking-stats/agent-tools.js`、`src/entrypoints/feishu/index.js`、`src/entrypoints/web/{routes-requirements.js,colleague-dev.js}`

## 一、背景与拍板记录

现状（问题）：同事在群里 @ 机器人提问 → 判定与执行在 web 进程 → 回复固定经 `sendTextToUser(colleague.feishuOpenId)` 发**私聊**。后果：群里其他人看不到答复（像机器人没理人），提问人也要切到私聊才知道结果。

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 群里 @ 出来的提问，回复发哪 | **回那个群，并 @ 提问人**（用户拍板 2026-10-13） |
| 2 | 是否保留私聊副本 | **不保留**。只回群里，不再私聊（避免同一内容打扰两遍；提问人从群里的 @ 获得通知） |
| 3 | 私聊里问的 | 原行为不变（回私聊） |
| 4 | 异步结果算不算「答复」 | 算。`tracking_report` 的结论、`colleague-dev` 的收尾简报都按同一路由回（否则「群里问、几分钟后答复跑进私聊」的错位） |
| 5 | 其它私聊推送 | 不动。任务完成卡片 / 会话通知 / `feishu-ask` 委托卡 / `notify_host` 是**主动推送给特定人**，不是对群消息的答复，维持私聊定向 |

## 二、路由规则（唯一一份：`shared/reply-target.js#resolveReplyTarget`）

| 输入 | 输出 |
|---|---|
| `chatType==='group'` 且 `chatId` 非空 | `{kind:'group', receiveId:群id, at:'<at user_id="ou_xxx"></at> '}` |
| 其它（p2p / chatType 缺失 / chatId 空） | `{kind:'p2p', receiveId:open_id, at:''}` |

- `at` 前缀只群聊拼；p2p 里 `<at>` 标签会渲染成怪串（与 `shared/mention.js` 同一纪律，open_id 白名单校验防拼进标签属性）。
- **降级不静默**：拿不到群坐标（chatType 缺失或 chatId 空）就回私聊 —— 宁可回私聊，也不能让同事等一个永远不来的回复。
- 发送原语：`integrations/lark.js#sendTextToTarget(creds, target, text)`（群聊 `sendTextToChat` 发 chat_id 并前置 at / 私聊 `sendTextToUser`）。两个新原语与 `sendTextToUser` 同构：**临时 client + 显式 creds**——web 进程的单例 client 不随设置页换机器人更新（`resetApiClient` 只在飞书入口热重载路径上调用）。

## 三、链路上要带什么（chatType 透传）

```
feishu onInbound（M.chatType；群聊仅 @ 放行）
  ├─ 文本 → feature.js（ctx.meta.chatType）─┐
  └─ 附件 → relayColleagueAttachment（m.chatType）─┤ relay.js 归入 payload
                                                  ▼
                    POST /api/req/colleague-agent/turn {chatId, chatType}
                                                  ▼
        routes-requirements.js#handleColleagueAgentTurn（chatType 透传，不校验枚举）
                                                  ▼
        colleague-agent/session.js#handleColleagueTurn
          ├─ 主回复 / 限流 ACK / 失败 ACK → resolveReplyTarget → sendTextToTarget
          ├─ agent ctx 带 chatType → tracking_report 结果同路由回发
          └─ start_dev_task 入队 payload 带 chatId/chatType
                → web/colleague-dev.js#replyColleague 收尾简报同路由回发
```

- **prompt 同步**：`colleague-agent/prompt.js#buildSystemPrompt` 收 `chatType`，群聊语境如实写
  「回复会直接发进这个群、群里其他人也看得到」——否则模型按「私聊」的口气组织措辞，与实际可见性对不上。

## 四、失败语义

| 失败点 | 行为 |
|---|---|
| 群聊发送失败（不在群/权限/限流） | `sendTextToChat` 记 warn、返 false，不抛；与私聊发送同语义（调用方不重试，失败即日志） |
| chatType/chatId 缺失 | 降级私聊（见 §二），绝不静默 |
| `replyColleague` 发送失败 | 不落 out 消息（界面不显示一条其实没送达的），返回 false；调用方 fire-and-forget |

## 五、测试与门禁

- `shared/reply-target.test.js`：群聊/私聊/chatType 缺失/chatId 空/openId 非法注入/参数全缺。
- `colleague-agent/session.test.js`：群聊回群并 @、chatId 缺失降级、群聊限流 ACK 也回群、ctx 带 chatType。
- `colleague-agent/{relay,feature}.test.js`：chatType 透传与空串归一。
- `tracking-stats/agent-tools.test.js`：群聊结果回群（与主回复同判定）。
- `colleague-agent/tools/req-write.test.js`：`start_dev_task` payload 带 chatId/chatType。
- `entrypoints/web/colleague-dev.test.js`：`replyColleague` 群聊路由（注入 send 断言目标）+ 私聊原行为。
- `entrypoints/web/routes-requirements.test.js`：turn 路由 chatType 透传。
- 门禁：`npm test` 全绿（4107）；无前端改动，不涉及 e2e。

## 六、不做（边界）

- 群聊多人协作（agent 同时面对多个角色 / 多角色各自上下文）仍不立项（2.0 遗留项）。
- 私聊定向的推送链路（任务卡片 / 会话通知 / 委托卡 / notify_host）不迁移到群。
- 群回复的「回复(quote)」形态不做——用 @ 提问人的文本回复，实现最简单、群里可读性最好。
