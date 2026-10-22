# Claude bypass 档 deny 守卫（PreToolUse 钩子）· 设计

- 日期：2026-10-11
- 状态：已实现（与本文档一并提交）
- 关联：`docs/codex-borrowing-analysis.md` §7「可借鉴 ①」（原文：Claude 路径补上策略执行点——SDK 的 PreToolUse hook 里执行 `tool-policy` 判定；不要让 `bypassPermissions` 成为策略真空）；上游 T6 工具策略（`tool-policy.logic.js` 规则表 + `tool-policy.js` 运行时门）、T6 spec §4.1 记的「bypass 档 Claude 路径不回调 canUseTool」不对称性
- 范围：`src/capabilities/tool-policy.js`、`src/capabilities/tool-policy.test.js`、`src/entrypoints/web/run-claude.js`、`src/capabilities/tool-policy.logic.js`（注释）；Claude 路径两处接线（交互 run-claude、无人值守 buildUnattendedClaudeOpts）。**openai 路径不动**（本来就能拦）。

## 1. 背景与问题

- 现状：Claude 路径 `bypassPermissions` 档下 **SDK 不回调 `canUseTool`**（T6 spec §4.1 自认的盲区）——危险命令 deny 名单（删根/毁盘/taskkill 一类灾难性命令）在这个档位完全失效。无人值守默认档（`bot.execPolicy` 未配置 = bypass）与交互「绕过」档、程序化起跑（req-chat 等）都受影响。
- Codex 对照（报告 §7）：审批面之外，灾难性命令（`rm -rf /`、`dd of=/dev/sda`…）有独立于审批模式的 forbid 语义；本项目规则表已有该名单（`detectDangerousCommand`，独立于档位），只差一个在 bypass 档仍会被调用的**执行点**。
- SDK 能力：Claude Agent SDK 支持 `hooks.PreToolUse` 回调，输出 `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow'|'deny'|'ask' } }` 可直接阻断工具调用；返回 `{}` = 不表态。本仓库已有先例（`PRETOOL_ASK_HOOK` 的 ask 强制回调用法）。

## 2. 目标与非目标

**目标**

1. **bypass 不再真空**：Claude 路径 `bypassPermissions` 档命中 hard deny（危险命令等 `decideToolAction('bypassPermissions') === 'deny'`）→ PreToolUse 钩子阻断并附可读原因；其余工具不表态，沿用旁路语义。
2. **审批面不变**：bypass 档不弹任何审批（不装 `canUseTool` 回调），与改动前一致——只补 deny 名单这一层。
3. **覆盖中途切档**：Claude 路径支持 `run.startMode='default'` → `acceptEdits`/`bypassPermissions` 中途放宽（`store/runs.setRunMode`）——钩子**调用时读取当前档位**，切到 bypass 立刻有守卫、切回 default 立刻恢复 ask。
4. **单点实现**：一个工厂 `buildClaudePretoolHook` 服务交互路径与无人值守路径；规则判定复用 `decideToolAction`（单一事实源）。

**非目标**

- **不碰 openai 路径**：`canUseTool`（策略门）在 bypass 档本来就被调用，名单已设防。
- **不扩大 bypass 档的拦截面**：不拦disabledTools/越界读写/网络——bypass 的语义就是「跳过审批」，只拦灾难性命令（与 `bypassPermissions` 档矩阵自身的 deny 结果严格一致，不extra加码）。
- **不做审批记忆/规则文件**（报告 §7 建议②，推后）；不做沙箱档次显式化（建议④，推后）。
- **不改 SDK 钩子的其它用途**：`PRETOOL_ASK_HOOK` 保留原样（standard/trusted 无人值守仍走它 + `canUseTool`）。

## 3. 拍板记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 实施路径 | 走报告建议①：PreToolUse 钩子（SDK 官方支持，先例 `PRETOOL_ASK_HOOK` 已实证 ask 通路可用）；不走②包装层拦截（要包全部内置/MCP 工具，面大且 SDK 内部工具包不到）。 |
| 2 | 工厂形态 | `buildClaudePretoolHook({ levelOf, workspace })` 返回 `{ PreToolUse: [...] }`；`levelOf` 支持函数（读 `run.mode`）或字符串。 |
| 3 | 档位语义 | `bypassPermissions` → 只拦 deny 名单（命中 deny，其余 `{}`）；`default` → 恒 ask（与 `PRETOOL_ASK_HOOK` 同语义，交回 canUseTool）；`acceptEdits`/`plan` → `{}` 不表态（维持 SDK 原语义）。 |
| 4 | 接线范围 | `run-claude.js` 恒挂动态钩子（替换原「仅 default 挂 ask 钩子」，修复中途切档后钩子不匹配）；`buildUnattendedClaudeOpts` 的 bypass 分支挂静态守卫（`levelOf: 'bypassPermissions'`）。standard/trusted 分支不变。 |
| 5 | 拦截依据 | 复用 `decideToolAction({ level: 'bypassPermissions' })`——与档位矩阵同源，名单演进自动跟随；不另写匹配逻辑。 |
| 6 | 可观测性 | 拦截时 `logger.warn('tool-policy', 'bypass 档 deny 名单拦截', { tool, ruleId })`；不新增 journal 事件（钩子层拿不到 run 上下文，保持 capabilities 层零 store 依赖）。 |
| 7 | 失败姿态 | 钩子函数抛错按 SDK 语义会 fail-open（不表态）——判定函数 `decideToolAction` 为纯函数且已全量单测，无可抛点；不额外包 try/catch（与 `PRETOOL_ASK_HOOK` 先例一致）。 |

## 4. 实现

- `tool-policy.js#buildClaudePretoolHook`：动态档位钩子工厂（`levelOf` 函数/字符串）。

  ```js
  async (input) => {
    const level = readLevel() || 'default';
    if (level === 'bypassPermissions') {
      const decision = decideToolAction({ toolName: input?.tool_name, input: input?.tool_input, level: 'bypassPermissions', workspace });
      if (decision.action !== 'deny') return {};
      logger.warn(...);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } };
    }
    if (level === 'default') return ASK_HOOK_OUTPUT;
    return {};
  }
  ```

- `buildUnattendedClaudeOpts` bypass 分支：`{ permissionMode: 'bypassPermissions', hooks: buildClaudePretoolHook({ levelOf: 'bypassPermissions', workspace }), policy: resolved }`。
- `run-claude.js`：`hooks: buildClaudePretoolHook({ levelOf: () => run.mode || 'default', workspace: cwd })`（不再条件挂载）。
- 注释同步：`tool-policy.logic.js` 文件头「deny 名单拦不到」改为「由钩子兜底」。

## 5. 测试

- `tool-policy.test.js`：
  - bypass 档 opt 装配：无 `canUseTool`、有钩子；灾难性命令（`rm -rf /`）→ deny + 可读原因；例行命令 → `{}`。
  - 动态档位：default → ask；acceptEdits → `{}`；bypass → 拦灾难性（含 `taskkill`）但不拦越界写（审批面语义不变）；切回 default → 恢复 ask。
- 本地验证：`npm test`（全量）与 `npm run lint`。

## 6. 风险与回退

- **SDK 语义依赖**：若未来 SDK 在 bypass 档跳过 PreToolUse 钩子，守卫静默失效——与 ask 钩子同一机制（已实证有效），升级 SDK 时需回归；本条为已知边界，记于此。
- **误杀面**：守卫只复用既有 deny 名单（宁漏勿误杀原则早已定），不引入新规则；改规则表即改守卫行为。
- 回退：删除两处钩子接线即回到「bypass = 与改动前一致（名单真空）」，无数据/协议面影响。
