# 未提交变更面板 · 设计（把「本次会话改动」降级成「未提交改动」，并改成右侧抽屉）

- 日期：2026-10-16
- 状态：已实现（与本文档一并提交）
- 关联：`docs/superpowers/specs/2026-10-16-session-changes-panel-design.md`（上一代，本文**取代**它的口径与容器形态）、`docs/ARCHITECTURE.md`
- 范围：新增 `src/features/workspace-changes/`（纯逻辑 + IO + 测试）、`src/entrypoints/web/routes-workspace-changes.js`（+测试）；**删除** `src/features/session-changes/`、`routes-session-changes.js`（+测试）；`public/js/changes-panel.js` 改数据源与容器形态，`index.html` / `app.js` / `app.css` / `public/js/chat.js`（新增 `getCwd` 出口）改接线；`tests/e2e-panels-smoke.mjs` 更新夹具与交互。

## 1. 背景：上一代为什么「还是有点问题」

上一代（`session-changes`）的口径是「**本次会话**改了什么」，因此只能扫会话转录拿动作清单，
再用「反向重放自证 > `file-history` 会话起点快照 > 片段模式」三级降级去猜 before 内容。它的毛病是结构性的：

1. **口径绑死在会话上**：换个窗口、换条分支、或者文件在会话结束后又被谁动过，答案立刻对不上；
   `file-history` 被清理过时还会整批退化成没有行号的片段。
2. **猜出来的 diff 要标基线**：面板底部得解释「这是与工作区比 / 与快照比 / 按新建处理」——
   用户看到的每一处都要先理解一套降级规则。
3. **走 Bash 的改动（`sed` / `mv` / `git checkout`）根本不在转录里**，如实缺席。

而维护者真正要回答的问题其实是：**我这个项目现在有哪些东西还没提交**。这在 git 里有精确答案。

## 2. 目标与非目标

**目标**

1. 口径改为 **HEAD 基线**：工作区（已暂存 + 未暂存）相对最后一次提交的差异，**与会话无关**。
   同一目录下不管在哪个会话里，看到的都是同一批未提交改动。
2. before/after 由 git 给出（已跟踪文件直接解析 `git diff HEAD`），**行号永远精确**，
   三级降级、片段模式、逐文件基线标注整套复杂度随之删除。
3. 面板改成**右侧抽屉**：点顶栏按钮时不再把对话区整个换成整页面板（那看着就像开了个新窗口），
   而是从右往左滑出、贴在对话区上，聊天区与顶栏都还在。
4. 保留上一代已经磨好的呈现：清单 + 内容地图 + 双列行号 diff（统一 / 并排）、行内词级高亮、
   5s 跟随刷新、顶栏计数徽标。

**非目标**

- 不做「回滚 / 撤销改动」（那是 `store/agent-actions` 台账的职责）。
- 不做历史提交的浏览（看已提交的东西不是「未提交」的语义）。
- 不做二进制文件的内容展示：只有「它变了」这个事实，编造一版内容只会在面板上糊成乱码。
- 不区分「谁改的」：AI 改的、维护者手改的、别的工具改的都算。这正是「未提交」这个口径的定义。

## 3. 数据来源（实现即口径）

三条只读 git 命令，全部以项目目录为 cwd：

| # | 命令 | 作用 |
|---|---|---|
| 1 | `rev-parse --is-inside-work-tree` | 先确认是仓库；不是 → `reason='not-a-repo'`（正常答案，不是错误） |
| 2 | `diff <HEAD> --relative --no-color --no-ext-diff --no-textconv -U3` | 已跟踪文件的未提交改动（暂存 + 未暂存一次拿全） |
| 3 | `ls-files --others --exclude-standard -z` | 未跟踪文件（不在 diff 里，得单独列） |

关键点：

- **仓库没有任何提交时**用空树对象名当基线（`4b825dc...`），语义仍是「所有东西都未提交」，
  不必为「HEAD 不存在」写第二条分支。
- `--relative` 让路径相对项目目录、且**排除项目目录之外的改动**（一窗一项目）；
  `ls-files` 默认就是 cwd 相对路径（它需要 `--full-name` 才是仓库根相对）。
- 解析 `diff --git a/x b/y` 那行取路径是**兜底**（只有纯权限变更这种没有任何 `---`/`+++` 的块才用），
  因为那行天然有歧义（路径可以含 ` b/`）；常规情况一律走 `---`/`+++`/`rename to`/`Binary files`。
- `-c core.quotePath=false` + `diffPath()` 解引号：中文文件名在 diff 头部能拿到原样路径。
- 未跟踪文件读盘时做二进制（NUL 字节）与体积（≤512KB）判定，命中就只报「变了」，不给内容。

**响应**：`GET /api/workspace-changes?cwd=` → `{ ok, cwd, rev, empty, reason, truncated, summary, files[], tree }`；
`&view=summary` → 只回计数（顶栏徽标轮询走这条）。`files[i] = { path, oldPath, kind, added, removed, deleted, binary, modeOnly, diffMode, tooLarge, hunks[], oldTotal, newTotal, truncated }`，
`kind ∈ {add, modify, delete, rename}`。

- **`rev` 是内容指纹**（对 `git diff` 原文做 FNV-1a）：前端 5s 一轮询，判断「要不要重画」只比
  「文件数 / 增删行数」是不够的 —— 把 `bar(x)` 改成 `baz(x)` 时行数一个没变，面板却必须重画。
- **上限**：单文件行数 ≤3000、跨文件总行数 ≤20000（超预算的文件整份撤掉 hunk，计数仍全量）、
  文件数 ≤300、未跟踪文件 ≤200。理由：现在扫的是整个工作区，不像上一代只扫「本次动过的文件」，
  「没进 .gitignore 的 node_modules」是真的会出现。
- 缓存：按 cwd、TTL 1.5s，外加在途请求合并 —— 面板轮询与徽标轮询常撞在同一秒。

## 4. 前端：抽屉而不是整页

- 点 `#changesBtn` → `.sc-drawer-host`（`position:fixed; inset:0; pointer-events:none`）+ `.sc-drawer`
  （右贴边、`width: min(1240px, 94vw)`、`animation: sc-slide-in`）。**`top: 44px` 让开顶栏**：
  收起抽屉靠的就是顶栏那个按钮，被自己盖住就点不到了。
- **非模态**：没有遮罩、点别处不关（同 `.cc-drawer` 的取舍）。审计时往往还要照着对话区看改动，
  点一下别处就消失的抽屉没法「边看边干活」。关闭走 Esc / ✕ / 再点一次顶栏按钮。
- 数据源是**项目 cwd**（`chat.js` 新增 `getCwd()`），不再需要「当前会话必须有 session」；
  没有再出现 `no-transcript` 那种「读不到转录」的分支，空态只剩三种：没选目录 / 不是仓库 / 有干净的。
- diff 面板底部只留一句固定口径说明（「与最后一次提交（HEAD）对比：已暂存与未暂存的改动都算」），
  不再有逐文件的 `baseline` 标注。
- 拿不到内容时按原因分开说：二进制 / 只有权限变化 / 文件过大 / 改动过多 —— 这四者用户要做的事完全不同。
- 离开对话视图自动收起抽屉（否则它会盖在设置 / 行为面板上）；在别的视图里点顶栏按钮先回对话再展开。

## 5. 验证

- 单测：`changes.logic.test.js`（21 项，纯逻辑：patch 解析 / diff / 树 / 预算 / 指纹）、
  `collect.test.js`（8 项，**真 git 仓库**夹具：路径基准、已暂存算不算、未跟踪、二进制、缓存）、
  `routes-workspace-changes.test.js`（4 项，HTTP 边界）。
- 结构类比上一代更强：`.logic` 里没有任何 fs / 子进程，`.collect` 只跑 git。
- 冒烟：`tests/e2e-panels-smoke.mjs` 改断言 —— 打开必须是 `.sc-drawer`（且**不得**再出现
  `panel-page[data-view="changes"]`）、再点顶栏按钮必须收起；「有数据」那段用
  `addInitScript` 把 `window.__PROJECT_CWD__` 钉成固定值再桩 `/api/workspace-changes`，
  否则这台机器的 cwd 由服务端偏好给出，会走到「不是 git 仓库」的空态上。
