# 诊断脚本 doctor（`npm run doctor`）· 设计

- 日期：2026-10-11
- 状态：已实现（与本文档一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §12「可借鉴 6」（原文：类比 `codex doctor`，把「端口/凭证/数据目录/数据文件一致性」检查写成一个脚本，出机器可读报告）
- 范围：`scripts/doctor.mjs`（新）、`package.json`（`doctor` script）、根 `CLAUDE.md`（命令表）。**纯新增，不改任何运行时模块**。

## 1. 背景与问题

- 排障现状：坏状态的表现高度分散——端口被占（`EADDRINUSE`）、`.env` 缺失（功能静默退化）、数据文件被截断（store 读取时才报）、docker 装了没起（容器后端 fail-closed 拒跑 Bash）、claude CLI 没装（Claude 路径全灭）。每一类都要用户/维护者手工逐项验证。
- Codex 的 `doctor` 子命令把「环境探测 + 配置检查 + 诊断报告」收敛成一条命令。本项目数据面（settings/run-index/run-journal）与执行面（local/container、claude CLI）已趋于完整，适合照搬这一入口。

## 2. 目标与非目标

**目标**

1. **一条命令看全貌**：`npm run doctor` 输出逐项 ✓/⚠/✗/– 摘要 + 通过/警告/失败计数。
2. **机器可读**：`--json` 输出纯 JSON（stdout 无其它内容），`{ ok, generatedAt, platform, dataDir, summary, checks[] }`；有 `fail` 退出码 1，否则 0。
3. **只读纪律**：不建目录、不写文件、不动锁、不打业务日志（`--json` 纯净性优先：不 import 任何会 `console.log` 的运行时模块）。
4. 检查面覆盖报告点名的四类（端口/凭证/数据目录/数据文件一致性），另加运行面三项（Node/依赖/claude CLI）与执行面两项（exec 后端/MCP 命令）。

**非目标**

- 不做修复（`--fix`）——只报告不动手；修复入口分别是设置页、`npm install`、重启应用。
- 不做网络/外网连通性、不探测飞书 API（凭证存在性即可，实测连接是运行时的事）。
- 不替代 e2e/单测：doctor 检「环境就绪」，不检「代码正确」。

## 3. 检查清单（实现即口径）

| # | id | 判定 | 严重级 |
|---|----|------|--------|
| 1 | `node` | 主版本 ≥20 | fail |
| 2 | `deps` | `node_modules` 存在且 `ai`/`zod`/`@anthropic-ai/claude-agent-sdk` 可解析 | fail |
| 3 | `env-file` | `.env` 候选（`envFileCandidates`）第一个存在者已加载；全缺 → warn | warn/ok |
| 4 | `lark-creds` | `LARK_APP_ID`+`LARK_APP_SECRET` 齐 | warn |
| 5 | `data-dir` | `appDataDir()` 可读可写 | fail |
| 6 | `file:*` | `settings.json` / `run-index.json` / `pending-resume.json` 可解析（未创建 = skip，非错） | fail |
| 7 | `legacy:active-runs` | 旧 `active-runs.json` 非空 → 提醒下次启动迁移 | warn |
| 8 | `file:run-journal` | 末行可解析（尾 64KB 回看）；半截行 → 提醒（对账按前缀语义处理） | warn |
| 9 | `corrupt-backups` | 数据目录 `*.corrupt.bak` 遗留清单 | warn |
| 10 | `port` | `PORT`（默认 3000）可 listen；被占 = 可能本应用已在运行 | warn |
| 11 | `claude-cli` | `claude --version` 成功（仅自定义模型可忽略） | warn |
| 12 | `exec-backend` | `local` → ok；`container` 且 docker/podman 任一可用 → ok，都不可用 → **fail**（fail-closed 会拒跑 Bash） | fail |
| 13 | `mcp` | 启用中的 MCP server `command` 可解析（`where`/`which`）；缺失列出 | warn |

口径细节：
- 引擎探测与 `exec-backends.js#probeEngines` 同命令（`<engine> version --format {{.Server.Version}}`，5s 超时）；doctor 不 import 运行时模块（避免日志污染 stdout），实现就地一份。
- `.env` 用 `loadAppEnv`（与启动同语义、只读第一个候选），日志经 `log: ()=>{}` 静音；环境变量解析失败 → warn 而非进程退出。
- 退出码经 `process.exitCode` 设置（不用 `process.exit`，防 Windows 管道截断 stdout）。
- `--json` 输出**纯 ASCII**（非 ASCII 字符转义为 `\uXXXX`）：Windows 控制台/管道按本地代码页重编码，原样输出会被吞成 `?`；转义后任何解析器语义不变、任何代码页下无损。

## 4. 测试与验证

- 手工验证记录（2026-10-11，本机 win32/Node 24）：
  - 正常态：11 ok · 0 warn · 0 fail · 2 skip，exit 0；
  - `--json`：stdout 可被 `JSON.parse`、stderr 为空；经 PowerShell 管道（`| node -e`）仍可解析（ASCII 转义）；
  - 临时 `APP_DATA_DIR` + `settings.exec.backend=container`（本机无 docker/podman）：`exec-backend` = fail、`file:settings.json` = ok、exit 1。
- 无自动化单测：`scripts/` 无既有测试范式（npm test glob 不含 `scripts/`），判定逻辑刻意保持「一行一处」便于视检；若未来加测试，把纯判定抽 `scripts/doctor.logic.mjs` 再注册进 glob 即可。

## 5. 风险与回退

- 误报面：`where`/`which` 与 shell 差异（Windows `.cmd` shim）导致「命令可解析」误判——命令不存在时至多 warn，不阻断；`claude --version` 已单独做 Windows shell 处理。
- 端口检查在极端防火墙策略下可能探测失败 → 归为 warn（不 fail），避免把环境限制误报成产品故障。
- 回退：删除 `scripts/doctor.mjs` + `doctor` script 即可，零运行时影响。
