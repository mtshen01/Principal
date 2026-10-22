# 图片附件进自定义模型（openai-compat）· 设计（2026-10-15）

## 问题

同一张图，Claude 路径能看，自定义模型（openai-compat，如 `deepseek-v4.1-flash`）永远看不见——
用户只能得到「请描述一下图片内容」之类的空转回答。模型本身支持 vision（opencode 直连同一模型可识别），
断点在应用管道。

## 根因（代码级证据）

1. **输入侧**：web 输入框的附件 chip 发送时只序列化为「绝对路径文本」（`public/js/composer.js:getPromptText`），
   图片本体从未进入请求。
2. **发送侧**：openai 路径的 user 消息 `content` 是纯字符串（`src/entrypoints/web/run-openai.js` 构建
   `modelMessages` 时），AI SDK 消息里没有任何 image/file part；仓库设计文档也自认
   （`2026-10-11-send-time-context-normalize-design.md:34`「openai 路径无 image/file part」）。
3. **兜底侧**：内置 Read 是纯文本工具，二进制直接报错（`src/providers/builtin-tools.js:looksBinary`），
   模型想「自己读一下」也读不到。
4. Claude 路径能用是因为 Claude Code SDK 自带的 Read 原生读图；opencode 能用是因为它把图片编码成
   image 内容块直发 provider。二者都不适用于我们的 openai 路径。

## 方案（模型边界视图变换）

**元数据落盘、图片在模型边界内联**——两层分离，互不污染：

```
前端 chip ──attachments:[{path,name}]──▶ /api/run/start(/send)
                                            │
                              ┌─────────────┴──────────────┐
                              ▼                            ▼
                    conv-messages（检查点）        模型边界 prepareMessages
                    { role:'user', content,        user 消息 →
                     attachments:[…] }              [ {type:'text'}, {type:'file',data,mediaType} ]
                    纯文本 + 元数据，无 base64        （provider 映射 image_url data URL）
```

### 各层改动

| 层 | 改动 |
| --- | --- |
| 前端 | `composer.js#getPromptAttachments()`（发送前取 chip → `{path,name}`）；**粘贴图片**上传成附件 chip（此前 paste 一律降纯文本，截图连路径都拿不到）；无名剪贴板文件按 MIME 造带扩展名上传名 |
| 路由 | `/api/run/start`、`/api/run/send` 归一 `attachments` 并随消息进 busy inbox（holdMsg / follow-up 项） |
| 检查点 | 用户消息落 `attachments` 元数据（不含 base64）；`context-budget` 按 `IMAGE_TOKEN_ESTIMATE` 计入估算 |
| 模型边界 | `run-openai.js#prepareMessages` → `capabilities/image-attachments.logic.js`：读图（per-run 缓存）→ `{type:'file', data, mediaType}`；provider 层 `prepareMessages` 透传给 adapter，agent-loop `await modelRun(...)` 兼容异步 |
| 插话 | 持有消息带 `attachments` 进对话（agent-loop `injectSteers`），步边界注入的图片同样能被内联 |

### 口径（拍板）

- 只处理消息上**显式**的 `attachments` 元数据（前端 chip 结构化上送），不扫正文路径——正文里随手写的路径
  不是「用户要给我看的图」；
- 类型判定按**魔数**（扩展名只在「是否值得报错」时作提示），改名/无扩展名的截图也认；非图片附件
  （pdf/代码…）静默走原有路径文本链路，不产生噪音；
- **视图变换**：返回副本并剥掉 `attachments` 字段；落盘/压缩/检查点仍持原消息（含元数据），
  每步 `prepareMessages` 重新按最新对话内联（含步边界插话）；
- 重放窗口与上限：最近 **2** 条带附件的用户消息参与（本轮 + 上一轮追问）、单轮 ≤ **4** 张、
  单张 ≤ **4MB**、单轮总量 ≤ **12MB**；超出只报告不回退（路径文本仍在，工具仍可用）；
  图片在每步请求里都要重复计费，不能无限重放；
- **fail-open**：读取失败/超限/不是图片只写一条活动回执（按路径去重，每 run 一次），绝不抛错阻塞 run；
- 活动回执：`🖼 图片已随消息发给模型：xxx.png` / `⚠️ 图片未随消息发送：xxx.png（原因）`——
  用户能确认图片到底发没发出去；
- Claude 路径**不消费** `attachments`（那边继续靠正文路径 + SDK Read）；前端两种 provider 都带上，
  保证 busy inbox 排队/降级重启不丢元数据。

## 非目标

- 不做 provider 视觉能力探测（是否支持图片由端点决定，不支持时请求会失败并可见）；
- 不在落盘里存 base64（`conv-messages.json` 会无限膨胀）；
- 不处理历史里已被删除的图片（重新读不到就退回纯文本，回执说明原因）；
- 飞书补充内容重注入仍只带文本（`injectToConv` 已预留 attachments 形参）。

## 测试

- `src/capabilities/image-attachments.logic.test.js`：归一/嗅探/内联/上限/去重/缓存/失败报告（注入 IO，零磁盘）
- `src/capabilities/context-budget.logic.test.js`：图片附件固定估值计入（非图片不计）
- `src/providers/agent-loop.test.js`：插话附件元数据随注入进对话并落检查点
- `src/store/runs-held.test.js` / `src/store/runs-inbox.test.js`：持有/排队项保留附件元数据
- `src/providers/openai-compat-model.test.js`：`prepareMessages` 异步被 await、file part 真到达模型提示词、原消息不被改写
- `src/providers/openai-compat.test.js`：provider 把 `input.prepareMessages` 透传到 modelRun 构造点
- `src/entrypoints/web/run-openai.attachments.test.js`：端到端接线（落盘无 base64 / prepareMessages 内联 / fail-open）
- `public/js/composer.attachments.test.js`：粘贴图片 → 上传 → chip → `getPromptAttachments`（真 DOM）
