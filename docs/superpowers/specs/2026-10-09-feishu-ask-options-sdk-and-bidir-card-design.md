# 「问同事」三次增强：单选卡 / Claude SDK 工具 / 双向卡片 · 设计

> 状态：**已实现**（2026-10-09，①②③ 一次交付；单测 3929 全绿，web 端点冒烟通过）｜ 日期：2026-10-09 ｜ 影响面：`src/capabilities/feishu-ask*.js`（改 + 新增 `feishu-ask-sdk.js` / `feishu-ask-card.js`）、`src/entrypoints/web/run-claude.js`、`run-openai.js`、`routes-requirements.js`、`routes-run.js`、`src/entrypoints/feishu/index.js`、`src/store/runs.js`、`public/js/chat.js`、`public/app.css`

## 一、背景与目标

「委托同事对话」子引擎（`capabilities/feishu-ask*.js`）目前只挂在 **openai-compat（自定义模型）** 路径：主模型 `AskColleague` 发一张**纯文字**飞书卡，同事手动打字回复，`WaitColleagueReply` 阻塞拿结论。三个痛点：

1. **问题又杂又多**：模型常把多件事塞进一段 `question`，同事无从下手。
2. **Claude SDK 路径没有这套工具**：只有自定义模型能问同事。
3. **web 执行台看不到、也不能干预**：问同事时页面无感知，主机与同事两条线各管各的。

本设计解决三件事（一次交付，分①②③三块实现，③是①②的自然延伸）：

- **① 一次一问 + 选项**：`AskColleague` 强制每次只问一个问题，并给 2~4 个选项；飞书卡从文字卡变「问题 + 选项按钮」，同事**点一下即答**，也可继续文字回复。
- **② Claude SDK 也能调**：把 `AskColleague` / `WaitColleagueReply` 以**进程内 MCP server** 注入 Claude 路径，走同一套策略门（提问走审批卡、等待免审批）。
- **③ 双向卡片**：web 执行台同步展示同样的「问题 + 选项」卡。主机点选项 → 委托立即结算为「开发者已确认：X」并回同事；同事飞书回复确认 → 结算 → web 侧卡片收起。

## 二、拍板记录

> 下列是我拟的默认口径，动手前请确认；任何一条都可推翻。

| # | 决策点 | 结论 |
|---|---|---|
| 1 | `options` 是否强制 | **强制**：`AskColleague` 的 `options` 必填、2~4 个字符串。schema 挡住「只问不给选项」；模型实在无法枚举时按工具描述给兜底选项（「知道了 / 不清楚 / 稍后再说」）。理由：③的双端交互全靠点选项，缺选项会让卡片没按钮、双向联动断一半 |
| 2 | 同事点选项的语义 | **当作一次回答喂进判定引擎**（转录里记 `（点选）X`），仍走现有判定/追问闭环，不是「点了就立刻结算」。理由：保留「确认细节」的能力，且与文字回复同一套判定，不另起一条结算路径 |
| 3 | 主机在 web 点选项的语义 | **立即结算**：结论＝「开发者已确认：X」，并给同事发一条「开发者已确认：X」文本。同事那侧当前问题视作已了结（不再追问） |
| 4 | 同事飞书端卡片是否要更新为「已确认」 | **第一版只发文本**（复用 `sendTextToUser`）；卡片就地更新需要存 `messageId` + lark 改卡，列为**可选增强**，先不做 |
| 5 | Claude 路径的工具注入方式 | **进程内 MCP server**（`createSdkMcpServer`，名 `feishu-ask`），照抄 `agent-tools.js#buildAgentMcpServer` 的范式；工具全名 `mcp__feishu-ask__AskColleague` / `mcp__feishu-ask__WaitColleagueReply` |
| 6 | Claude 路径策略门 | `WaitColleagueReply` 加进 `readOnlyExtra`（**全名**，`tool-policy.logic.js` 是 `Set.has(name)` 精确匹配）；`AskColleague` 落 `classifyTool→other`→默认「询问」档弹审批卡，与 openai 路径口径一致 |
| 7 | web 端卡片通道 | **新增非阻塞 notice 卡**（`presentNotice`/`dismissNotice` + SSE `notice`/`notice-dismiss`），**不动**现有阻塞式 `askUser`（那是工具审批/交互提问，语义不同） |
| 8 | 主机 web 点选项 → 结算后回给主模型 | `WaitColleagueReply` 正常 `concluded` 返回，结论文本＝「开发者已确认：X」，主模型照常消费 |
| 9 | 新增端点归属 | 加在 `routes-requirements.js`（同事链路都在那）；两个：`/api/req/feishu-ask/answer`（同事点飞书卡）与 `/api/req/feishu-ask/confirm`（主机点 web 卡） |

## 三、数据流

### ① + ③ 发起与同事选项回流

```
web 进程（openai / claude 两条路径都会走到）
  AskColleague(question, options[2..4])           → genQuestionId（先于建卡）
    → buildAskCard({question, context, options, questionId})  按钮 value={kind:'feishu-ask-answer', questionId, option}
    → sendCardToUser → 飞书卡（问题 + N 个选项按钮 + 「或直接回复」）
    → tasks.set(questionId, {…, options}) + presentNotice(run, {id:questionId, 问题+选项})  → web 执行台同卡

飞书进程
  同事点选项按钮 → onCardAction → value.kind='feishu-ask-answer'
    → feishu-ask-card.js#handler → POST /api/req/feishu-ask/answer {questionId, option}（3s 超时 fire-and-forget）

web 进程
  handleFeishuAskAnswer(questionId, option) → task 命中且 waiting
    → transcript.push({dir:'in', text:`（点选）${option}`}) → scheduleStep → 判定引擎 → 追问 or 结算
```

### ③ 双向结算

```
主机在 web 卡点选项：
  chat.js submitFeishuAskConfirm → POST /api/req/feishu-ask/confirm {questionId, option}
    → handleFeishuAskConfirm：settle(task,'concluded',{conclusion:`开发者已确认：${option}`})
        + sendTextToUser(同事, `开发者已确认：${option}`)
        + dismissNotice(questionId)   ← 两端口卡一起收
    → 主模型 WaitColleagueReply 拿 concluded（结论＝开发者已确认：X）

同事飞书回复确认（文字或点选项）：
  判定引擎 parseJudgeResult done=true → settle(task,'concluded',{conclusion})
    → dismissNotice(questionId)   ← web 卡收起
    → 主模型 WaitColleagueReply 拿 concluded
```

## 四、实现落点

### ① 一次一问 + 选项

**`src/capabilities/feishu-ask-tools.js`**
- `AskColleague.inputSchema` 增加：
  `options: z.array(z.string().min(1)).min(2).max(4).describe('让对方点选的选项（2~4 个）。实在无法枚举时给「知道了/不清楚/稍后再说」这类兜底选项。')`
- `description` 改成强调「一次只问一个最关键的问题，并给 2~4 个选项让对方点选」。
- `executeTool` 的 AskColleague 分支透传 `options: input.options`。

**`src/capabilities/feishu-ask.logic.js`**
- `buildAskCard({question, context, options = [], questionId})`：正文照旧（question + 分隔线 + context）；`options` 非空时在底部渲染 `{tag:'action', actions: options.map(opt => ({tag:'button', text:{tag:'plain_text', content:opt}, type:'primary', value:{kind:'feishu-ask-answer', questionId, option:opt}}))}`；底部提示文案改为「点上方选项，或直接回复本条消息」。
- `buildJudgePrompt` 增加 `options` 入参，渲染一行「可选答案：A ／ B ／ C」，并在纪律里加「对方点选了某选项通常已是明确答复，尽量收敛结论」。

**`src/capabilities/feishu-ask.js`**
- `askColleague`：**先把 `genQuestionId()` 提到 `sendCard` 之前**，把 `questionId` 与 `options`（`(input.options||[]).map(String).map(trim)`，缺省给兜底三选项）传进 `buildAskCard`；task 上新增 `options`、`messageId`（存 `sendCard` 返回值，供可选增强改卡）。
- 新增 `handleColleagueAskOption(questionId, option, deps)`：按 `questionId` 直查 task，`status==='waiting'` 时推 `transcript`（`{dir:'in', text:'（点选）X', at}`）后 `scheduleStep`；否则返回 null。与 `handleColleagueAskReply` 共用内部 `feedReply` 小函数（省一份转录截断/判 waiting 逻辑）。

### ② Claude SDK 可调用

**`src/capabilities/feishu-ask-sdk.js`（新增）**
- `export const FEISHU_ASK_SDK_SERVER = 'feishu-ask';`
- `buildFeishuAskMcpServer({runId, convId, signal, pulse, activity})`：内部 `createFeishuAskTools(...)` 拿 `toolDefs/executeTool`，用 `createSdkMcpServer` + `tool(name, desc, schema, async input => executeTool(name, input))` 造 server（`alwaysLoad:true`）；返回 `{ server, readOnly: new Set([`mcp__${FEISHU_ASK_SDK_SERVER}__WaitColleagueReply`]) }`。

**`src/entrypoints/web/run-claude.js`**
- import `buildFeishuAskMcpServer` + `FEISHU_ASK_SDK_SERVER`。
- 在 `startClaudeRun` 内构造：`const feishuAskMcp = buildFeishuAskMcpServer({ runId: run.id, convId, signal: run.abortController.signal, pulse: () => runPulse(run), activity: (t) => runActivity(run, t) });`，把 `mcpServers` 从「仅内置」改为 `{ [FEISHU_ASK_SDK_SERVER]: feishuAskMcp.server, ...builtinMap }`（不再可为 null）。
- `createPolicyGate({...})` 增加 `readOnlyExtra: feishuAskMcp.readOnly`。
- （打磨）权限卡标题里 `toolName` 是全名，展示时可用 `summarizeTool` 已有的美化；不阻塞。

### ③ 双向卡片

**`src/store/runs.js`**
- 新增 `presentNotice(run, {id, kind, title, body, options})`：`run.notices`（`Map`）set + `fanout(run,'notice',{id,kind,title,body,options})`。
- 新增 `dismissNotice(run, id)`：删 + `fanout(run,'notice-dismiss',{id})`。
- 新增 `drainNotices(run)`：清空并对每个发 dismiss；在五个终结口（`finishRun`/`failRun`/`blockRun`/`retryRun`/`stopRun`）与 `drainAsks` 同处调用（或复用它们已有的收尾点）。
- 提供 `getRun(runId)`（若尚无，加一个只读取器）供 `feishu-ask.js` 按 `runId` 拿 run 对象。

**`src/capabilities/feishu-ask.js`**
- `deps` 增加 `presentNotice` / `dismissNotice` / `getRun`（默认指向 `store/runs.js`，注入便于单测）。
- `askColleague` 成功建 task 后：`getRun(task.runId)` 存在则 `presentNotice(run, {id: task.questionId, kind:'feishu-ask', title:`问同事：${colleague.name}`, body: question(+context), options: task.options})`。
- `settle()` 内（concluded/abandoned/expired/cancelled 汇聚点）追加 `dismissNotice(run, task.questionId)`（run 不存在时静默跳过）。
- 新增 `confirmAskFromHost(questionId, option, deps)`：校验 task 且 `waiting`、`option` 非空（有 options 时须命中其一）→ `settle(task,'concluded',{conclusion:`开发者已确认：${option}`})` + `sendTextToUser(creds, task.openId, '开发者已确认：' + option)`（失败仅 warn，结算不受影响）。settle 内部已负责 `dismissNotice` 与唤醒 waiter。

**`src/entrypoints/web/routes-requirements.js`**
- 新增 `handleFeishuAskAnswer(req,res)`：读 `{questionId, option}` → `handleColleagueAskOption` 命中则 202 `{ok:true,delegated:true}` 并 `step.catch(...)`；否则 404/200。
- 新增 `handleFeishuAskConfirm(req,res)`：读 `{questionId, option}` → `confirmAskFromHost`，202。
- 路由表（`if (pathname === ...)` 链，现约 1129 行）加两条：`POST /api/req/feishu-ask/answer`、`POST /api/req/feishu-ask/confirm`。

**`src/capabilities/feishu-ask-card.js`（新增，仅飞书进程 import）**
- 模块加载即 `registerCardKindHandler('feishu-ask-answer', handler)`；`handler(data)` 解析 `data.action.value`（`{kind,questionId,option}`）→ `fetch('http://127.0.0.1:'+config.web.port+'/api/req/feishu-ask/answer', {POST, AbortSignal.timeout(3000)})`（照抄 `relay.js#realPostToWeb` 的 3s 超时 fire-and-forget，不重试）。

**`src/entrypoints/feishu/index.js`**
- 顶部加 `import '../../capabilities/feishu-ask-card.js';`（注释说明：注册「问同事」选项卡回调 kind，处理器跨进程回流 web）。

**`public/js/chat.js`**
- 复用 `.ask-card/.ask-title/.ask-body/.ask-opts` 样式，新增一个非阻塞渲染 `renderAskNoticeCard(job, notice)`（加 `.ask-notice` 类区分），插入点同 `renderTodoPanel`（`.tool-log-single` 或 `.tool-log` 之后），**不替换** run-status。
- `job.notices`（`Map`/对象）+ 两个 SSE 监听：`notice`（`JSON.parse` 后 set + 重绘）、`notice-dismiss`（删 + 重绘）。
- 选项按钮 `onclick` → `fetch('/api/req/feishu-ask/confirm', {POST, {questionId, option}})` → 乐观删卡 + `refreshAskChip` 不涉及（notice 不进审批徽标）。
- job 结束/重启清空 `job.notices`。

## 五、测试与验收

- 单测（`node --test`）：
  - `feishu-ask.logic.test.js`：`buildAskCard` 带选项时按钮 `value` 含 `questionId/option`、无选项时退纯文字；`buildJudgePrompt` 带 `options` 渲染可选答案行。
  - `feishu-ask.test.js`：`handleColleagueAskOption` 命中/未命中、`confirmAskFromHost` 结算结论与「开发者已确认」通知、`settle` 触发 `dismissNotice`（注入替身断言）。
  - `feishu-ask-tools.test.js`：schema 缺 `options` 或不足 2 个时被 zod 拒。
  - `runs.test.js`（或新增）：`presentNotice`/`dismissNotice`/`drainNotices` 的 SSE 广播。
- 手工验收（web + 飞书双端）：
  1. 自定义模型开发任务里问同事 → 飞书收到「问题 + 选项」卡、web 执行台同卡。
  2. 同事飞书点选项 → 判定收敛后 web 卡收起，主模型拿到结论。
  3. 主机 web 点选项 → 同事飞书收到「开发者已确认：X」、两边卡收起、主模型拿到结论。
  4. Claude SDK（`claude-agent`）路径发起问同事 → 同一套卡与联动全部可用；`WaitColleagueReply` 免审批、`AskColleague` 弹审批卡。

## 六、风险与护栏

- **分层**：`feishu-ask.js` 引入 `store/runs.js` 属 capabilities→store，合规；但为可测，一律走 `deps` 注入、默认值指向 store。
- **飞书卡片 value 是服务端签发**（含 questionId），不依赖回调里的 open_id 做归属；故不引入 open_id→colleagueId 的额外校验，防止伪造按钮。
- **notice 卡与阻塞 ask 卡并存**：一个 run 可能同时有「工具审批卡（阻塞）」与「问同事卡（非阻塞）」，前端渲染必须**各自独立**（`job.ask` vs `job.notices`），不得互相覆盖（runs.js 里 `pending` 被覆盖是历史事故，notice 用 Map 天然多卡，无此风险）。
- **Claude 路径全名匹配**：`readOnlyExtra` 必须用 `mcp__feishu-ask__WaitColleagueReply` 全名（`tool-policy.logic.js` 是精确 `Set.has`），写短名会静默变成「每次等待都弹审批」。
- **双向结算的竞态**：主机点选项与同事回复几乎同时到达时，`settle` 的 `status!=='waiting'` 早退保证只结算一次；后到者 `handleColleagueAskOption`/`confirmAskFromHost` 查 task 已非 waiting 自然 no-op。
- **process 边界**：`feishu-ask-card.js` 只被飞书入口 import（web 进程 import 它只是多注册一个不会被调用的 handler，无副作用，但保持只 import 飞书侧更清晰）。
