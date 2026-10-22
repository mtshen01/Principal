#!/usr/bin/env node
/**
 * doctor —— 本机健康自检（报告 §12 可借鉴 6，类比 `codex doctor`）。
 *
 * 只读纪律：不建目录、不写文件、不动锁、不打业务日志——任何检查失败都归入报告，
 * 不用「先写后删探针」这类有副作用的做法。退出码：有 fail → 1，否则 0（可进 CI/脚本）。
 *
 * 用法：
 *   node scripts/doctor.mjs          # 人类可读（✓/⚠/✗ 三色文字摘要）
 *   node scripts/doctor.mjs --json   # 机器可读（stdout 纯 JSON，便于管道/巡检）
 *
 * 检查面（对应报告 §12：「端口 / 凭证 / 数据目录 / 数据文件一致性」）：
 *   node 版本 / 依赖就绪 / .env 与飞书凭证 / 数据目录可写 / 核心数据文件可解析
 *   （run-index、pending-resume、settings、旧 active-runs 残留、run-journal 尾部完整性、
 *   *.corrupt.bak 遗留）/ 端口占用 / claude CLI / 执行后端（docker/podman）/ MCP 命令可解析
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appDataDir, isPackaged } from '../src/shared/app-paths.js';
import { envFileCandidates, loadAppEnv } from '../src/shared/load-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const JSON_MODE = process.argv.includes('--json');

/** 收集检查结果：{ id, title, status: 'ok'|'warn'|'fail'|'skip', detail } */
const checks = [];
const add = (id, title, status, detail) => checks.push({ id, title, status, detail });

// ---------- 小工具 ----------

/** 解析 JSON 文件；missing 按「未创建」处理（不算错——还没跑过应用而已） */
function readJsonSafe(file) {
  if (!fs.existsSync(file)) return { missing: true };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/** 读文件尾部最后一个非空行（最多回看 64KB；JSONL 完整性检查用） */
function tailLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    return { last: lines[lines.length - 1] ?? '', size };
  } catch (e) {
    return { error: e?.message || String(e) };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关 */
      }
    }
  }
}

/** 命令是否可解析（绝对/相对路径直接看文件；否则 where/which） */
function commandResolvable(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return false;
  if (s.includes('/') || s.includes('\\')) return fs.existsSync(path.resolve(s));
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [s], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}

/** 探测一个容器引擎（与 exec-backends 的探针同语义：`<engine> version --format {{.Server.Version}}`） */
function probeEngine(engine) {
  try {
    const r = spawnSync(engine, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? String(r.stdout || '').trim() || '可用' : null;
  } catch {
    return null;
  }
}

/** 端口占用探测：能 listen 即空闲；EADDRINUSE 视为「可能已在运行」（warn 而非 fail） */
function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        srv.close();
      } catch {
        /* 未 listen 时 close 会抛，忽略 */
      }
      resolve({ status, detail });
    };
    const timer = setTimeout(() => finish('warn', `端口 ${port} 探测超时（3s）`), 3000);
    srv.once('error', (e) =>
      e?.code === 'EADDRINUSE'
        ? finish('warn', `端口 ${port} 已被占用（可能本应用已在运行）`)
        : finish('warn', `端口 ${port} 探测失败：${e?.code || e?.message || e}`),
    );
    srv.once('listening', () => finish('ok', `端口 ${port} 空闲（127.0.0.1，可直接启动）`));
    try {
      srv.listen(port, '127.0.0.1');
    } catch (e) {
      finish('warn', `端口 ${port} 非法：${e?.message || e}`); // PORT 超界等同步抛出
    }
  });
}

// ---------- 1. 运行时与依赖 ----------

const nodeMajor = Number(process.versions.node.split('.')[0]);
add(
  'node',
  'Node 版本',
  nodeMajor >= 20 ? 'ok' : 'fail',
  `v${process.version.replace(/^v/, '')}（要求 ≥20${nodeMajor >= 20 ? '' : '，请升级 Node LTS'}）`,
);

const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const missingDeps = ['ai', 'zod', '@anthropic-ai/claude-agent-sdk'].filter(
  (d) => !fs.existsSync(path.join(NODE_MODULES, ...d.split('/'))),
);
add(
  'deps',
  '依赖就绪',
  missingDeps.length ? 'fail' : 'ok',
  missingDeps.length ? `node_modules 缺 ${missingDeps.join('、')}——先跑 npm install` : 'node_modules 与关键依赖齐备',
);

// ---------- 2. .env 与凭证 ----------

const loaded = loadAppEnv({ log: () => {} }); // 与启动同语义；日志静音保证 --json 纯净
const existingEnvFiles = envFileCandidates(process.env).filter((c) => fs.existsSync(c));
if (!existingEnvFiles.length) {
  add('env-file', '.env 文件', 'warn', `未找到 .env（已找：${envFileCandidates(process.env).join(' | ')}）——外部注入或打包配置可忽略`);
} else if (loaded.loaded) {
  const skipped = existingEnvFiles.filter((f) => f !== loaded.loaded).length;
  add('env-file', '.env 文件', 'ok', `已加载 ${loaded.loaded}${skipped ? `（低优先级 ${skipped} 份未读取）` : ''}`);
} else {
  add('env-file', '.env 文件', 'warn', `发现 ${existingEnvFiles[0]} 但解析失败，已跳过（外部注入可忽略）`);
}
if (loaded.error) {
  add('env-parse', '.env 解析', 'warn', `解析失败已跳过：${loaded.error}`);
}

const hasLark = !!(process.env.LARK_APP_ID && process.env.LARK_APP_SECRET);
add(
  'lark-creds',
  '飞书凭证',
  hasLark ? 'ok' : 'warn',
  hasLark ? 'LARK_APP_ID / LARK_APP_SECRET 已配置' : '缺 LARK_APP_ID / LARK_APP_SECRET——飞书入口不可用（仅 Web/自定义模型可忽略）',
);

// ---------- 3. 数据目录 ----------

const dataDir = appDataDir();
let dataDirStatus = 'ok';
let dataDirDetail = `${dataDir}（${isPackaged() ? '打包态 APP_DATA_DIR' : '开发态仓库根'}）`;
try {
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
} catch {
  dataDirStatus = 'fail';
  dataDirDetail = `${dataDir} 不可读或不可写（${isPackaged() ? '检查 APP_DATA_DIR 权限' : '检查仓库目录权限'}）`;
}
add('data-dir', '数据目录', dataDirStatus, dataDirDetail);

// ---------- 4. 数据文件一致性 ----------

const CORE_JSON = [
  ['settings.json', '设置与凭证'],
  ['run-index.json', 'run 索引（崩溃恢复唯一来源）'],
  ['pending-resume.json', '待续跑队列'],
];
for (const [name, title] of CORE_JSON) {
  const r = readJsonSafe(path.join(dataDir, name));
  if (r.missing) add(`file:${name}`, title, 'skip', `${name} 未创建（尚未跑过应用即正常）`);
  else if (r.error) add(`file:${name}`, title, 'fail', `${name} 解析失败：${r.error}（应用启动会另存 .corrupt.bak 并告警）`);
  else {
    const n = Array.isArray(r.value) ? `，${r.value.length} 条` : '';
    add(`file:${name}`, title, 'ok', `${name} 可解析${n}`);
  }
}

// 旧表残留（P5 起 retire）：下次启动会迁移清空；非空即提醒，不算错
const legacy = readJsonSafe(path.join(dataDir, 'active-runs.json'));
if (!legacy.missing && Array.isArray(legacy.value) && legacy.value.length) {
  add('legacy:active-runs', '旧 active-runs 残留', 'warn', `active-runs.json 尚有 ${legacy.value.length} 条——下次启动会迁移进 run-index 并清空`);
}

// run-journal 尾部完整性（追加写；崩溃可能留半截行 → 只告警，前文不受影响）
const journal = path.join(dataDir, 'run-journal.jsonl');
if (fs.existsSync(journal)) {
  const t = tailLine(journal);
  if (t.error) add('file:run-journal', 'run 审计流', 'warn', `run-journal.jsonl 读取失败：${t.error}`);
  else {
    try {
      JSON.parse(t.last);
      add('file:run-journal', 'run 审计流', 'ok', `run-journal.jsonl 尾部完好（${(t.size / 1024).toFixed(0)} KB）`);
    } catch {
      add('file:run-journal', 'run 审计流', 'warn', 'run-journal.jsonl 末行不完整（疑似上次写中途退出；对账逻辑会按前缀语义处理）');
    }
  }
}

// 损坏备份遗留（store 读取坏文件时的第一次快照）——排除测试数据目录，只看真数据目录
let corrupt = [];
try {
  corrupt = fs.readdirSync(dataDir).filter((n) => n.endsWith('.corrupt.bak'));
} catch {
  /* dataDir 不可读已在上面报 fail */
}
add(
  'corrupt-backups',
  '损坏文件备份',
  corrupt.length ? 'warn' : 'ok',
  corrupt.length ? `发现 ${corrupt.length} 份：${corrupt.slice(0, 5).join('、')}${corrupt.length > 5 ? '…' : ''}（人工检查后可将好文件改名回原位）` : '无 *.corrupt.bak 遗留',
);

// ---------- 5. 端口 ----------

const port = Number(process.env.PORT) || 3000;
const portCheck = await checkPortFree(port);
add('port', 'Web 端口', portCheck.status, portCheck.detail);

// ---------- 6. claude CLI ----------

// Windows 上是 .cmd shim，需 shell 解析；固定字符串避免 shell+args 的 DEP0190
const claude =
  process.platform === 'win32'
    ? spawnSync('claude --version', { encoding: 'utf8', timeout: 15000, shell: true })
    : spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15000 });
if (claude.status === 0) {
  add('claude-cli', 'claude CLI', 'ok', `claude ${String(claude.stdout || '').trim().slice(0, 80)}`);
} else {
  add('claude-cli', 'claude CLI', 'warn', '未找到可用 claude CLI——Claude 路径不可用（仅用自定义模型可忽略；安装/登录见 Claude Code 文档）');
}

// ---------- 7. 执行后端（settings.exec；容器配置了引擎却不可用 = fail-closed 会拒跑 Bash） ----------

const settings = readJsonSafe(path.join(dataDir, 'settings.json'));
const exec = settings.value?.exec && typeof settings.value.exec === 'object' ? settings.value.exec : {};
if (exec.backend === 'container') {
  const eng = probeEngine('docker') ? 'docker' : probeEngine('podman') ? 'podman' : null;
  add(
    'exec-backend',
    'Bash 执行后端',
    eng ? 'ok' : 'fail',
    eng
      ? `容器后端可用（引擎 ${eng}，镜像 ${exec.image || 'node:22-bookworm'}，网络 ${exec.network ? '开' : '关'}）`
      : '已配置容器后端但未检测到可用 docker/podman——Bash 将拒绝执行（fail-closed，不静默退回本机）',
  );
} else {
  add('exec-backend', 'Bash 执行后端', 'ok', `本机执行（settings.exec.backend=${exec.backend || 'local（默认）'}）`);
}

// ---------- 8. MCP 服务器命令可解析 ----------

const mcpServers = Array.isArray(settings.value?.mcpServers) ? settings.value.mcpServers : [];
const badMcp = mcpServers.filter((m) => m?.enabled !== false && m?.command && !commandResolvable(m.command));
if (!mcpServers.length) add('mcp', 'MCP 服务器', 'skip', '未配置 MCP 服务器');
else if (badMcp.length) {
  add('mcp', 'MCP 服务器', 'warn', `${badMcp.length}/${mcpServers.length} 个命令不可解析：${badMcp.map((m) => m.label || m.command).join('、')}`);
} else {
  add('mcp', 'MCP 服务器', 'ok', `${mcpServers.length} 个服务器命令均可解析`);
}

// ---------- 输出 ----------

const failed = checks.filter((c) => c.status === 'fail');
const warned = checks.filter((c) => c.status === 'warn');
const report = {
  ok: failed.length === 0,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  dataDir,
  summary: { ok: checks.filter((c) => c.status === 'ok').length, warn: warned.length, fail: failed.length, skip: checks.filter((c) => c.status === 'skip').length },
  checks,
};

if (JSON_MODE) {
  // 纯 ASCII 输出：Windows 控制台/管道按本地代码页重编码，非 ASCII 可能被吞成 '?'——
  // 机器读的 JSON 经 \uXXXX 转义后可在任何代码页下无损传输（解析器语义完全一致）。
  const json = JSON.stringify(report, null, 2).replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  console.log(json);
} else {
  const icon = { ok: '✓', warn: '⚠', fail: '✗', skip: '–' };
  console.log(`Principal doctor · ${report.generatedAt} · ${process.platform} · 数据目录 ${dataDir}`);
  for (const c of checks) {
    console.log(`${icon[c.status]} ${c.title}：${c.detail}`);
  }
  const s = report.summary;
  console.log(`\n结果：${s.ok} 项通过 · ${s.warn} 项警告 · ${s.fail} 项失败${s.skip ? ` · ${s.skip} 项跳过` : ''}（exit ${report.ok ? 0 : 1}）`);
}
process.exitCode = report.ok ? 0 : 1; // 不用 process.exit：Windows 管道下立即退出可能截断 stdout
