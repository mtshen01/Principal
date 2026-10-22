# CI 门禁（P0-⑤）· 设计

- 日期：2026-10-11
- 状态：已实现（本文档与实现一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §12 / §14 P0-⑤
- 范围：新增 `.github/workflows/ci.yml`；不改任何运行时代码。

## 1. 背景与问题

- 现状：仓库只有 `release.yml`（推 `v*.*.*` tag 时构建安装包）——**推送与 PR 上没有任何测试门禁**；
- 报告 §12 的缺口原文：「无常规 CI（仅 release.yml）」「262 单测 + 14 e2e 全靠人记得跑」；`run-e2e.mjs` 的诞生背景（2026-08-28）也正是「门禁长期失败而无人知晓」（e2e-panels-smoke 硬编码 tab 已重构掉）——**没有 CI 的安全网仍会锈**；
- Codex 侧对应实践：nextest archive 分片跨 5 平台跑测试（平台矩阵本项目暂不需要，但「测试必须过」的基线门禁要有）。

## 2. 拍板记录（2026-10-11）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 范围 | 报告 P0 表口径：`npm test` + **e2e 子集**。lint 未做——仓库没有 lint 工具链（无 eslint/biome/prettier 配置），先不引新依赖，留 P1 |
| 2 | e2e 子集 | **无浏览器组**：`openai-resume` + `openai-retry`。它们是真 server + 真 AI SDK 适配器 + 真 HTTP 假端点，覆盖检查点/对账/发送前 normalize/模型流重试四类最容易回归的链路；playwright 组要额外装 chromium（CI 时间翻倍）、且本地存在预存失败（one-window），暂不进门禁 |
| 3 | 触发 | `push` + `pull_request` 全量事件（不猜默认分支名）；tag 推送仍走 release.yml |
| 4 | 运行环境 | `ubuntu-latest` + Node **22**（README 要求 LTS ≥20；`node --test` 的 glob 形态需要 ≥21；本地开发 24，用 22 顺带覆盖最低可用档）；两条 job（test / e2e）并行 |
| 5 | 复用执行器 | e2e 用现成的过滤器：`npm run test:e2e -- openai-resume openai-retry`（`run-e2e.mjs` 自起后端子进程、逐个跑、汇总退出码），不另写 CI 专用脚本 |

## 3. 设计（`.github/workflows/ci.yml`）

```yaml
on: [push, pull_request]
jobs:
  test:   checkout → setup-node(22, cache npm) → npm ci → npm test
  e2e:    checkout → setup-node(22, cache npm) → npm ci → npm run test:e2e -- openai-resume openai-retry
```

- 依赖安装的 `postinstall`（superpowers 技能包拉取）是 **fail-open**（网络失败只告警 exit 0），CI 不受影响；
- e2e job 不装浏览器：子集脚本零 playwright 依赖；
- 端口 3000 由 `run-e2e.mjs` 自起自收（runner 环境干净，无复用歧义）。

## 4. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 子集外的 e2e 仍可能静默锈掉 | 子集选的是最能代表集成链路的两个；P1 再扩浏览器组（装 chromium 后全量） |
| CI 首次跑可能暴露平台差异（本地 Windows） | 失败即修（这正是门禁的目的）；必要时先把该 job 降为非必过再排查——不允许直接删门禁 |
| `npm ci` 拉 @tauri-apps/cli 等大包耗时 | setup-node 的 npm cache 命中后通常在分钟级；暂不拆依赖 |
| 回滚 | 删 `ci.yml` 即可；不改任何运行时行为 |

## 5. 实施状态

- [x] `.github/workflows/ci.yml`（test + e2e 子集两条 job）
- [x] spec / 分析报告状态同步

> P1 加厚（lint 门禁 + e2e 浏览器组）已另行落地：`docs/superpowers/specs/2026-10-11-ci-hardening-design.md`。
