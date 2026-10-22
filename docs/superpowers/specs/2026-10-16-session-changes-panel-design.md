# 本次会话改动面板（取代谢「项目地图」）· 设计

> ⚠️ **已被取代（2026-10-16 当天）**：本文的「扫会话转录 + 三级降级」口径与「整页 `panel-page`」容器形态
> 都已下线，改由 [`2026-10-16-uncommitted-changes-drawer-design.md`](./2026-10-16-uncommitted-changes-drawer-design.md)
> （未提交变更 + 右侧抽屉）取代。本文保留作历史记录 —— 它记录的降级规则与踩过的坑仍是理解那版实现的入口。

- 日期：2026-10-16
- 状态：已实现，**后被取代**（见上方提示）
- 关联：`docs/codex-borrowing-analysis.md`（codex / opencode 的「会话结束可看本次 diff」能力）、`docs/ARCHITECTURE.md`
- 范围：新增 `src/features/session-changes/`（含纯逻辑 + IO + 测试）、`src/entrypoints/web/routes-session-changes.js`（+测试）、`public/js/changes-panel.js`、`public/js/changes-diff.logic.js`（+测试）、`public/js/changes-map.logic.js`（+测试）；**删除**原「项目地图」全链路（`src/features/project-map/`、`project-map-ops.js`、`routes-project-map.js`、`public/js/project-map-panel.js`、`tests/project-map/`、`uiPrefs.projectMapIdleRefresh`、`modelTasks.projectMap`）；`server.js` / `index.html` / `app.js` / `app.css` 改接线；新增依赖 `diff`（jsdiff）。

## 1. 背景与问题

1. 原「项目地图」要跑一次只读 agent 才产出内容，答的是「项目长什么样」；而维护者在审计一轮 AI 工作后真正要回答的是「**刚才这一轮动了什么**」。前者贵且与本次工作无关，后者零成本却无处可看。
2. codex / opencode 在会话中与会话结束都能看到本次改动清单与 diff，这是审计闭环里最常被用的一环。本项目已有「会话转录」这一份现成数据（`~/.claude/projects/<projectId>/<sessionId>.jsonl`），改动动作全在里面。

## 2. 目标与非目标

**目标**

1. 面板回答两个问题：**改了哪些文件**（清单：路径、增删行数、编辑次数、是否已删）与**改动落在项目哪个部位**（内容地图：目录树画布，底色深浅 = 改动量）。
2. diff 的呈现对齐 git / GitHub / VS Code：双列行号、`@@ -a,b +c,d @@` hunk 头、改动前后各 3 行上下文、中间用「⋯ 共 N 行未修改 ⋯」收掉、改动行内只高亮真正变了的词；统一视图与并排视图可切换。
3. **零 LLM、零额外成本**：数据只来自会话转录 + 工作区文件 + Claude Code 自己的 `file-history` 快照。
4. 会话进行中也能看：面板每 5s 跟随刷新（转录变了才重算，见 §4 缓存），顶栏徽标 15s 轮询 + run 结束时立即刷新。
5. 口径诚实：拿不到可信的 before 内容时**不给行号**，改用编辑片段模式并在面板上说明原因；diff 的基线口径（与工作区比 / 与快照比 / 按新建处理）在面板底部如实标注。

**非目标**

- 不做「回滚 / 撤销改动」。撤销已有独立的 `store/agent-actions` 台账（那是按动作授权模型）。
- 不覆盖走 Bash 的改动（`sed` / `mv` / `git checkout`）：转录里没有「改了哪几行」，硬猜会给出错的 diff。
- 不做 git 基线（`git diff` / `git stash create` 快照）：那会把上一轮会话与用户手改一起算进来，与「本次会话」这个口径冲突。
- 不做折叠区的点击展开（GitHub 是点开时再取一次数据；本轮不下发完整文件正文）。

## 3. 数据来源与三级降级（实现即口径）

内容从**转录的动作清单**推导，before/after 按可信度依次尝试：

| 级 | 条件 | before / after | `baseline` | 是否给行号 |
|---|---|---|---|---|
| 1 | 从盘上**反向重放**全部编辑能成功 | 反推结果 / 盘上内容 | `workspace` | 是 |
| 2 | 盘上已被后续改动，但 `file-history` 里有该文件的**会话起点快照**，且正向重放成功 | 快照 / 重放结果 | `session-start-snapshot` | 是 |
| 3 | 首个动作是整文件写入且无快照，但「写入后到会话结束」重放到盘上一致（或文件已删） | 空（按新建）| `assumed-create` | 是 |
| 4 | 以上都不成立 | — | `''` | 否（编辑片段） |

关键点：

- **反向重放自证**：只有当盘上内容真的含有每条编辑的 `new_string` 时，才能一条不落地撤回。撤得动就证明「盘上内容 == 本次会话重放的结果」，于是第 1 级的 before/after 是被验证过的，不是被假设的。
- **失败的工具调用必须回掉**：失败的 Edit（如「String to replace not found」）在转录里**同时**留下 `tool_use` 与 `is_error` 的 `tool_result`。不回掉它，重放会卡在「找不到 old_string」，把一个本该出 diff 的文件拖进片段模式。这是实测踩到的问题（本仓转录里 3512 条 tool_result 中有 27 条 is_error）。
- **撤销类动作不在范围**：`kind` 只区分「片段编辑」与「整文件写入」，`deleted` 由盘上是否存在决定。

## 4. 接口与缓存

`GET /api/session-changes?cwd=&sessionId=` → `{ ok, sessionId, cwd, empty, reason, truncated, summary, files[], tree }`；
`GET /api/session-changes?cwd=&sessionId=&view=summary` → 只回计数（顶栏徽标用）。

- `files[i]`：`{ path, kind, edits, added, removed, firstAt, lastAt, deleted, diffMode, baseline, oldTotal, newTotal, truncated, hunks[] | fragments[] }`。
- `diffMode='unified'` 时 `hunks[i].rows[j] = { t, oldNo, newNo, text, segs? }`，`t ∈ {' ','+','-'}`；`segs` 是行内词级分段（`{text, em}`）。
- 上限：单文件 before+after ≤ 512KB、下发行数 ≤ 3000、jsdiff 预算 3s（超时/超限 → 片段模式）；单次采集操作数 ≤ 2000，超出置 `truncated.shallow`。
- 缓存键 = 转录 `(mtime, size)`，最多 6 条：面板 5s 一轮询，而只有正在写的那份转录会失效。
- `sessionId` 白名单 `/^[a-zA-Z0-9_-]+$/`（它同时是文件名），非法 → 400。

## 5. diff 计算：用 jsdiff 而不是自己写

`diff`（jsdiff，BSD-3，9.2k star，Myers O(ND)）提供两件正好对口的能力，手写都是几百行的坑：

- `structuredPatch(old, new, {context: 3, timeout})` → 与 git 完全同构的 hunk（`oldStart/oldLines/newStart/newLines` + 行），并已处理「末尾缺换行」这类边角（转成 `\ No newline at end of file` 标记行，本实现把它挂到上一行、不占行号）。
- `diffWordsWithSpace(oldLine, newLine)` → 行内词级差异。改动占比 > 70% 时**放弃强调**，否则整行糊成一片反而看不出改了哪儿。

选它而不是 diff2html / CodeMirror-merge：那两者会自己产出 HTML，与「模型/文件文本一律 textContent、不裸 innerHTML」的项目纪律冲突；本项目要的是**结构化数据 + 自己的 DOM 渲染**。

## 6. 前端

- 视图：`data-view="changes"` 面板（`panel-page`），顶栏按钮 `#changesBtn`（带计数徽标 `#changesCount`），入口由 `app.js` 的 `showView` 统管。
- 两种主视图共用右侧 diff 面板：**列表**（左栏文件清单 + 右栏 diff）、**内容地图**（目录树画布 + 右栏 diff）。
- 排布纯函数单独可测：`changes-diff.logic.js`（`diffSegments` 算「N 行未修改」、`toSplitRows` 算并排配对）、`changes-map.logic.js`（`layoutChangeMap` 分层整齐树 + heat 归一）。
- 骨架只建一次、各区块原地更新（轮询不重建 innerHTML，否则筛选框丢焦点、滚动位置被重置）。

## 7. 验证

- 单测：`changes.logic.test.js`（41 项）、`collect.test.js`（6 项）、`routes-session-changes.test.js`（5 项）、`changes-diff.logic.test.js`（10 项）、`changes-map.logic.test.js`（8 项）。
- 一致性断言（实测 8 个文件全通过）：`Σ分隔条行数 + Σhunk 覆盖的旧行数 == oldTotal`；`Σhunk 内 +行/-行 == summary 的 added/removed`。
- 冒烟：`tests/e2e-panels-smoke.mjs` 增加「打开改动面板 → 主体渲染 → 两视图切换零 pageerror」一段。
- **2026-10-16 回归与补强**：重构 diff 视图时把 §6 里「主体（左清单 / 地图）+ 右 diff」那一整块
  CSS 删掉了，而上述冒烟只断言「面板里有文字」——面板照样有文字、照样零 pageerror，于是门禁全绿，
  用户点开看到的却是空白：左栏从定宽清单列变成通栏、右 diff 被挤到下面（两栏没有可滚动容器），
  内容地图的画布（`.rq-canvas-host` 是 `position:absolute`）丢了定位祖先，改以视口为参照铺满整页、
  节点被摆到视口外。补强两条：① 版面不变量按**几何**断言（`.sc-main` 是 flex、左栏 ≤ 400px、
  `.sc-mapwrap` 是定位祖先、两栏真的并排）；② 给面板喂一份固定数据（桩 `/api/session-changes`）
  后断言内容地图**至少有一个卡片落在面板可视区里** —— 空态永远画得出东西，只测空态等于没测。
