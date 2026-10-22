# CI 加厚（P1）· 设计 —— lint 门禁 + e2e 浏览器组

- 日期：2026-10-11
- 状态：已实现（本文档与实现一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §12 可借鉴 1（「PR 上跑 `npm test` + e2e 子集 + lint」）/ §14；前序 P0-⑤ `docs/superpowers/specs/2026-10-11-ci-gate-design.md`（其留白：lint 未做、浏览器组未进门禁，「P1 再扩」）
- 范围：`.github/workflows/ci.yml` 增两条 job；新增 `.oxlintrc.json` 与 `npm run lint`（devDependency `oxlint`）；`scripts/run-e2e.mjs` 加排除过滤；修复 lint 首跑实锤 13 处（含 1 个真 bug）。

## 1. 背景与问题

- P0-⑤ 门禁只覆盖 `npm test` + 两个无浏览器 e2e；两处留白：
  1. **无 lint**——仓库从未有 lint 工具链，风格问题靠人盯、真错误靠运气（本次立即抓出一个真 bug，见 §4）；
  2. **浏览器组不进 CI**——13 个 playwright 用例（当年拆 app.js 的安全网）仍靠人记得跑，`run-e2e.mjs` 诞生背景正是「门禁长期失败而无人知晓」；不进门禁就会再次锈掉。

## 2. 拍板记录（2026-10-11）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | lint 选型 | **oxlint**（Rust 单二进制、npm 一个 devDependency、零配置即可用、默认 correctness 类命中即可信）：不引 ESLint（插件/parser/全局环境配置面大，存量风格噪声多）也不引 Prettier（会卷进全仓格式化） |
| 2 | 门禁口径 | **只拦精选规则**：`.oxlintrc.json` 把 33 条高信号正确性规则显式提为 `error`（`no-const-assign` / `no-cond-assign` / `no-unsafe-finally` / `require-yield` / `no-template-curly-in-string` …）；oxlint 默认警告（`no-unused-vars` 88 条为主，合计 ~109）**不拦门禁**，避免一次性大扫除淹没本次改动。豁免必须用行内 `// oxlint-disable-next-line <rule> -- 理由` |
| 3 | 浏览器组范围 | 13 个 playwright 用例**除 `one-window`**：存量前端 WIP 已移除 `.conv-load-more` 元素（仅剩 CSS），用例待随前端更新后才可绿——不属本任务，纳入即红（见 §5）。`openai-resume`/`retry` 无浏览器依赖，留在原 e2e job 不重复 |
| 4 | 过滤语法 | `run-e2e.mjs` 过滤器加 `!` 前缀 = 排除，与包含词可混用（不改变既有「包含」语义）；CI 命令 `npm run test:e2e -- '!openai' '!one-window'` |
| 5 | chromium | CI 里 `npx playwright install --with-deps chromium`（runner 自带免密 sudo）；本地需 `npx playwright install chromium`（多数开发机已有） |
| 6 | 触发/环境 | 同 P0-⑤：push + PR、`ubuntu-latest`、Node 22、npm cache；四条 job 并行 |

## 3. 设计

```yaml
jobs:
  test:        checkout → setup-node(22, cache npm) → npm ci → npm test          # P0-⑤ 原样
  lint:        checkout → setup-node(22, cache npm) → npm ci → npm run lint      # 新增
  e2e:         ... → npm run test:e2e -- openai-resume openai-retry              # P0-⑤ 原样
  e2e-browser: checkout → setup-node(22, cache npm) → npm ci
               → npx playwright install --with-deps chromium
               → npm run test:e2e -- '!openai' '!one-window'                     # 新增
```

- `.oxlintrc.json`：`ignorePatterns: ["public/vendor/**", "tests/archive/**"]`（vendored 第三方与归档脚本不扫）+ 精选规则表；
- `package.json`：`"lint": "oxlint src public/js scripts tests benchmarks web.js"`（覆盖全部自研 JS/MJS 入口；CSS/HTML 不属 oxlint 范围）；
- 依赖：`oxlint@^1.87.0`（devDependency，lockfile 同步——`npm ci` 可复现）。

## 4. lint 首跑实锤（13 处）

| 位置 | 规则 | 处理 |
|---|---|---|
| `src/capabilities/agent-session.js:132/167` | `no-const-assign` | **真 bug**：`const` 解构出的 `model` 在「任务覆盖模型」分支被重赋值——该路径一执行即 `TypeError`，因无 SDK 级测试而潜伏。改 `let` 并注释原因（运行时回归测试需要 mock SDK 的注入缝，本仓库暂无该范式，防御由本规则静态把守） |
| `src/shared/load-env.test.js:32` | `no-constant-binary-expression` | `undefined ?? {}` 恒等于 `{}`——测试语意不清，改为直接传 `undefined` |
| `public/js/markdown-tool.js:414` | `no-cond-assign` | `while (node = walker.nextNode())` 补括号（语义不变） |
| `src/features/project-checkup/evidence/selectors-project.logic.js:432` | `no-sparse-arrays` | `[, '']` 稀疏数组 → `[undefined, '']`（语义不变） |
| `src/entrypoints/web/routes-git.js:10` | `no-useless-escape` | 字符类里的 `\-` 去掉（`-` 已在末尾，语义不变） |
| `src/features/project-checkup/evidence/selectors-code.logic.js:341` | `unicorn/no-useless-length-check` | `body.length === 0 \|\| body.every(...)` 里长度判断冗余（空数组 `every` 即 true）——删（默认警告类，顺手修复，不属门禁拦截） | 
| `src/store/submissions.js:38`、`src/entrypoints/web/routes-files.js:156`、`benchmarks/lib/cases.logic.js:23` | `no-control-regex` | 三处都是**刻意**匹配控制字符（键校验 / header 注入面 / 路径安全），行内豁免 + 理由 |
| `src/providers/agent-loop.test.js:603` | `require-yield` | 测试假流**故意**零产出（挂死触发空闲判死路径），行内豁免 + 理由 |
| `src/features/project-checkup/dimensions/rubrics-code.js:245,249`、`src/providers/builtin-tools.js:79` | `no-template-curly-in-string` | 示例文本 / glob 转义字符表里的 `${}` 是字面量，行内豁免 + 理由 |

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| CI 首次跑浏览器组暴露平台差异（本地 Windows 验证 12/12 绿，Linux 未验） | 失败即修（同 P0-⑤ 纪律）；必要时先降为非必过排查，**不允许直接删门禁** |
| `one-window` 被排除后无人盯 | 前端 WIP 落地、用例更新并通过本地验证后从排除列表摘除（记入交接） |
| oxlint 版本升级规则漂移 | 规则在 config 显式声明；升级时先本地 `npm run lint` 再落 CI |
| 40s 后端就绪 + 12 个用例串行使 job 变长 | 可接受（浏览器组本来只在本机跑，CI 化后仍与另三条 job 并行）；暂不拆分片 |
| 回滚 | 删两条 job / 删 `.oxlintrc.json` + `lint` 脚本 + devDependency；不触任何运行时行为 |

## 6. 实施状态

- [x] `.oxlintrc.json` + `package.json` `lint` 脚本 + devDependency `oxlint@^1.87.0`（lockfile 同步）
- [x] 13 处实锤修复/豁免（含 `agent-session.js` 真 bug）
- [x] `scripts/run-e2e.mjs` 排除过滤（`!` 前缀）
- [x] `.github/workflows/ci.yml`：`lint` + `e2e-browser` 两条 job
- [x] 本地验证：`npm run lint` 零错误（~109 条存量警告不拦，`no-unused-vars` 88 条为主）；浏览器组 `!openai !one-window` **12/12 通过**
- [x] spec / 分析报告状态同步
