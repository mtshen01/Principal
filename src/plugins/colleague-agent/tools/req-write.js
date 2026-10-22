/**
 * P2 的 2 个 reversible 工具 —— agent 从「能查能聊」到「能办事」的一步。
 *
 * 授权模型是「乐观执行 + 可撤销」（`capabilities/agent-tools.js` 文件头）：不等主机确认直接
 * 执行，但每次都必须留一个撤销锚点。两个工具都是 `danger:'reversible'`，注册期硬要求
 * `buildUndo` 存在且不得返回 null——这里不留任何一条能绕过去的路径。
 *
 * 与 `req-read.js` 共用的三条纪律同样适用（fail-closed 可见性 / 不倒整条记录 / 不给绝对路径），
 * 但 `visible`/`resolveVisible` 没有从那边导出，这里按同样口径本地重实现一份——
 * 两个文件都只服务同一个注册入口，重复五行判断换来的是彼此不必知道对方的内部结构。
 *
 * ## start_dev_task 的 buildUndo 为什么是「骨架」+ selfLedger
 *
 * 工具调用这一刻，任务刚入队，真正的分支/提交/mergeSha 要等 `colleague-dev.js` 里的 run
 * 跑完才有——那时 `commitAndMerge` 会写下**唯一一条**真实台账（undo 带真实 mergeSha）。
 * 这里的 `buildUndo` 只是满足注册期不变式的占位骨架，`mergeSha` 恒为 null。
 *
 * `selfLedger: true` 告诉通用写入器（`agent-tools.js#recordLedger`）**跳过即时写入**：
 * 否则「无代码改动 / run 失败」的任务也会留下一条撤不出任何东西的假骨架
 * （判据见 colleague-dev.js「无代码改动，不合并不写台账」）。撤销锚点的生产者是收尾路径，
 * 不是调用点——这是这个工具与 register_api_doc 的本质差别。
 *
 * ## 反向依赖怎么解的
 *
 * `registerApiDoc`/`enqueueSystemTask` 活在 `entrypoints/web/requirement-ops.js`，而分层是
 * `entrypoints → app → features/plugins → capabilities → integrations/store → shared`——
 * plugins 反向 import entrypoints/web 是明确违规。这里选**动态 import**（而不是要求调用方
 * 注入）：`index.js` 对 `buildReqReadTools`/`buildReqWriteTools` 一律零参调用、在**模块加载时**
 * 完成注册（与卡片回调同一范式），那个时间点既不知道也不该关心 requirement-ops 这个重模块
 * （内含 git / lark / claude 调用链）的装配细节；调用方注入会强迫这一层多背一份「从哪调进来」
 * 的管线，而动态 import 把加载推迟到工具真正被调用的那一刻——生产环境里 web 进程本就已经
 * 加载过 requirement-ops.js（`routes-requirements.js` 早早 import 了它），这里的动态 import
 * 命中的是模块缓存，零额外开销；唯一的代价是 handler 多一层 await，可忽略。
 */
import { z } from 'zod';
import { getRequirement as realGetRequirement, updateRequirement as realUpdateRequirement } from '../../../store/requirements.js';
import { pickProjectDir } from './req-read.js';
import { logger } from '../../../shared/logger.js';

/** P2/P4 装配的工具名清单（顺序即注册顺序） */
export const REQ_WRITE_TOOL_NAMES = [
  'register_api_doc', 'start_dev_task', 'submit_req_change', 'supplement_requirement', 'upload_design_ref',
];

/** 需求变动正文上限（与 /api/req/change 路由同口径） */
const CHANGE_TEXT_MAX = 5000;

/** 地图逻辑（mergeFigmas）的懒加载：纯函数模块，但住在 entrypoints（反向依赖），与 loadReqOps 同法 */
let mapLogicPromise = null;
function loadMapLogic() {
  if (!mapLogicPromise) mapLogicPromise = import('../../../entrypoints/web/req-map.logic.js');
  return mapLogicPromise;
}

/** 生成短 id（与路由层的命名格式一致） */
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 他参不参与这个需求（与 req-read.js#visible 同口径） */
function visible(req, colleagueId) {
  return !!req && !!colleagueId && (req.assignees || []).includes(colleagueId);
}

/** 取一个他可见的需求，取不到返回 { error }（与 req-read.js#resolveVisible 同口径） */
function resolveVisible(getRequirement, reqId, colleagueId) {
  const req = getRequirement(reqId);
  if (!visible(req, colleagueId)) return { error: `找不到需求 ${reqId}，或者你没有参与它` };
  return { req };
}

/** 非开发期的统一拒绝文案：给人话，不给 phase 字面量这种内部状态码 */
function notDevPhase(req) {
  return { error: `需求「${req.title}」当前不在开发期，这件事暂时办不了` };
}

/** requirement-ops.js 的懒加载单例：模块体积不小（git/lark/claude 调用链），只在真正要写时才付这份加载成本 */
let reqOpsPromise = null;
function loadReqOps() {
  if (!reqOpsPromise) reqOpsPromise = import('../../../entrypoints/web/requirement-ops.js');
  return reqOpsPromise;
}

export function buildReqWriteTools(deps = {}) {
  const getRequirement = deps.getRequirement || realGetRequirement;
  const registerApiDoc = deps.registerApiDoc || (async (req, opts) => (await loadReqOps()).registerApiDoc(req, opts));
  const enqueueSystemTask = deps.enqueueSystemTask || (async (reqId, kind, payload) => (await loadReqOps()).enqueueSystemTask(reqId, kind, payload));
  const updateRequirement = deps.updateRequirement || realUpdateRequirement;
  const readMapVersion = deps.readMapVersion || (async (req) => (await loadReqOps()).readMapVersion(req));
  const writeMapVersion = deps.writeMapVersion || (async (req, map) => (await loadReqOps()).writeMapVersion(req, map));
  const mergeFigmas = deps.mergeFigmas || (async (prev, incoming) => (await loadMapLogic()).mergeFigmas(prev, incoming));

  return [
    {
      name: 'register_api_doc',
      description:
        '把一份接口文档登记到需求上，前端联调靠它读取最新接口定义。仅开发期可用，仅登记，不读文档内容。' +
        '收到同事发来的接口文档文件时用它。',
      danger: 'reversible',
      roles: ['backend'],
      schema: {
        reqId: z.string().describe('需求 id，形如 r_xxxx'),
        name: z.string().describe('文档名，如 order.md（须与同事发来的文件名一致）'),
      },
      handler: async ({ reqId, name }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        if (r.req.phase !== 'dev') return notDevPhase(r.req);

        // 路径从 ctx.files 按文件名反查，**不经模型之手**——模型只知道文件名
        // （见 session.js 的 fileLine 注释：不给磁盘绝对路径）。
        // 模型报一个没收到过的文件名时，这里要明确回错，不能拿 undefined 去登记。
        const hit = (ctx?.files || []).find((f) => f.name === name);
        if (!hit?.path) return { error: `没有收到名为「${name}」的文件，请确认文件名` };

        const result = await registerApiDoc(r.req, { name, path: hit.path });
        if (!result?.ok) {
          // 下游错误文案（requirement-ops.js）里可能带磁盘绝对路径或 fs 报错原文，
          // 那是给人看（web UI 操作者）设计的，不能原样转发给模型——
          // 日志留全文供排查，回模型换固定短语（同 agent-tools.js#textResult 的边界脱敏范式）。
          logger.warn('colleague-agent', '接口文档登记失败', { reqId, name, err: result?.error });
          return { error: '接口文档登记失败，请稍后再试或换个方式发送文件' };
        }
        // 只回文档名与需求标题，不回存档后的绝对路径——模型没有工具去读它
        return { ok: true, reply: `已登记接口文档「${result.doc?.name || name}」，同步给需求「${r.req.title}」的开发` };
      },
      buildUndo: (input) => ({ kind: 'delete-apidoc', reqId: input.reqId, name: input.name }),
    },

    {
      name: 'start_dev_task',
      description:
        '把同事在对话里提出的开发诉求转成一个任务，立即安排 agent 接入改码。仅开发期可用。' +
        '执行前务必确认这就是同事想要的那个需求——回复会带上需求标题与分支，供同事当场核对，' +
        '一旦发现文不对题请让同事立刻喊停（spec §6.2：归属判错会把改动落到别的需求的分支上）。',
      danger: 'reversible',
      selfLedger: true, // 撤销锚点（分支/mergeSha）要等 run 收尾才有，由 colleague-dev.js 写；见文件头
      roles: ['backend', 'product', 'qa'],
      schema: {
        reqId: z.string().describe('需求 id，形如 r_xxxx'),
        task: z.string().describe('同事想要做的开发事项，尽量保留他的原话'),
      },
      handler: async ({ reqId, task }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        if (r.req.phase !== 'dev') return notDevPhase(r.req);

        const branch = (r.req.branches || []).find((b) => b.dir === pickProjectDir(r.req.projects))?.branch;
        const prompt = `需求「${r.req.title}」（${reqId}）的开发期任务，来自同事在对话中提出的诉求：\n${task}`;
        const title = '同事发起：' + task.slice(0, 30);

        const result = await enqueueSystemTask(reqId, 'colleague-dev', {
          msgId: ctx?.msgId || '',
          colleagueId: ctx?.colleagueId || '',
          prompt,
          title,
          // 回复路由（2026-10-13）：这条任务收尾时要回同事，回哪儿取决于他当时在哪问
          // （群里 @ 出来的回群里并 @ 他，私聊提的回私聊）。判定统一在 shared/reply-target.js。
          chatId: ctx?.chatId || '',
          chatType: ctx?.chatType || '',
        });
        // `enqueueSystemTask` 当前实现**恒返回 undefined**（requirement-ops.js:175，全函数无显式返回值），
        // 所以这条分支在生产里不可达。保留它防的是可注入的 `deps.enqueueSystemTask` ——
        // 替换实现若返回 `{ok:false}`，工具要如实转述，而不是谎报派活成功。
        // 前置的 `result &&` 不能删：少了它，undefined 会在这里抛 TypeError。
        if (result && result.ok === false) return { error: result.error || '任务入队失败' };

        // 必须明写需求标题 + 分支：归属判错的兜底不是让 agent 更小心，是让最知道答案的
        // 同事当场看见「咦这不是我要改的需求」
        return {
          ok: true,
          reply: `已受理，将在需求「${r.req.title}」（${reqId}${branch ? '，分支 ' + branch : ''}）上安排开发：${task}`,
        };
      },
      buildUndo: (input, _result, ctx) => ({
        kind: 'revert-merge',
        reqId: input.reqId,
        msgId: ctx?.msgId || null,
        repo: null,
        branch: null,
        baseBranch: null,
        mergeSha: null, // 待 colleague-dev.js#commitAndMerge 收尾时用真实值另写一条覆盖
      }),
    },

    // ── P4 的三个 reversible 工具：登记型副作用（记录 / 修订队列 / 地图引用），
    //    撤销锚点都在调用点当场生成，由 wrapper 即时写台账（非 selfLedger）。

    {
      name: 'submit_req_change',
      description:
        '把同事提出的需求变动登记到需求上（录入变更记录，有需求地图时地图会同步更新）。仅开发/测试期可用。' +
        '只登记变动、不直接改代码；如果同事要求这个变动现在就改，登记后另用 start_dev_task 安排开发。',
      danger: 'reversible',
      roles: ['product'],
      schema: {
        reqId: z.string().describe('需求 id，形如 r_xxxx'),
        text: z.string().describe('变动内容，尽量保留同事原话'),
      },
      handler: async ({ reqId, text }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const req = r.req;
        if (req.phase !== 'dev' && req.phase !== 'test') {
          return { error: `需求「${req.title}」不在开发/测试期，变动暂时登记不了（评审期请提补充说明）` };
        }
        const clean = String(text || '').trim().slice(0, CHANGE_TEXT_MAX);
        if (!clean) return { error: '先说说变动是什么' };

        const change = { id: genId('c_'), text: clean, scope: 'both', hits: [], at: new Date().toISOString() };
        updateRequirement(req.id, { changes: [...(req.changes || []), change] }, '需求变动：' + clean.slice(0, 30));

        // 有地图才值得跑一轮更新（与 /api/req/change 路由同判据）
        const hasMap = !!(req.reqMap?.versions || []).length;
        if (hasMap) await enqueueSystemTask(req.id, 'mapchange', { changeId: change.id, text: clean });

        return {
          ok: true,
          reply: `已记录需求变动《${req.title}》${hasMap ? '，地图会同步更新' : ''}。需要现在就调整代码的话，把要改的地方告诉我，我安排开发任务。`,
          __private: { changeId: change.id },
        };
      },
      buildUndo: (input, result) => ({ kind: 'revert-req-change', reqId: input.reqId, changeId: result?.__private?.changeId || null }),
    },

    {
      name: 'supplement_requirement',
      description:
        '把同事的补充说明（文字和/或附件）登记到需求上，评审期会自动纳入开发文档修订。仅评审期可用。' +
        '同事对需求文档做补充或修正时用它；他先发了文件再说话是常见节奏，附件文件名要和他发的一致。',
      danger: 'reversible',
      roles: ['product', 'design'],
      schema: {
        reqId: z.string().describe('需求 id，形如 r_xxxx'),
        text: z.string().optional().describe('补充说明正文（text 与文件至少要有一样）'),
        files: z.array(z.string()).optional().describe('同事这次发来的附件文件名列表（如 ["order.md"]）'),
      },
      handler: async ({ reqId, text, files }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const req = r.req;
        if (req.phase !== 'review') {
          return { error: `需求「${req.title}」不在评审期，补充说明要评审期才能提（开发期请走需求变动）` };
        }

        const t = String(text || '').trim();
        const names = Array.isArray(files) ? files.map(String) : [];
        const resolvedFiles = [];
        for (const name of names) {
          // 路径从 ctx.files 按文件名反查，**不经模型之手**（同 register_api_doc 的纪律）
          const hit = (ctx?.files || []).find((f) => f.name === name);
          if (!hit?.path) return { error: `没有收到名为「${name}」的文件，请确认文件名（只认同事这次发来的附件）` };
          resolvedFiles.push({ name: hit.name, path: hit.path });
        }
        if (!t && !resolvedFiles.length) return { error: '补充说明要有正文或附件，至少一样' };

        const supplement = { id: genId('s_'), text: t, files: resolvedFiles, at: new Date().toISOString() };
        // 先落盘再入队：runDocgen 读的是落盘的 req.supplements（与 /api/req/supplement 路由同顺序）
        updateRequirement(req.id, { supplements: [...(req.supplements || []), supplement] }, '提交补充说明');

        const ready = !!pickProjectDir(req.projects) && !!req.reqDoc;
        if (ready) await enqueueSystemTask(req.id, 'docgen', { supplement });

        return {
          ok: true,
          reply: ready
            ? `已记录补充说明，开发文档会按它修订（需求《${req.title}》）`
            : `已记录补充说明（需求《${req.title}》），配置齐全后会自动纳入`,
          __private: { supplementId: supplement.id },
        };
      },
      buildUndo: (input, result) => ({ kind: 'remove-supplement', reqId: input.reqId, supplementId: result?.__private?.supplementId || null }),
    },

    {
      name: 'upload_design_ref',
      description:
        '把一个 Figma 设计稿链接登记到需求地图的某个页面上（该页已有稿时是追加一张）。' +
        '同事发设计稿链接时用它；地图有多个页面而没指明哪页时，先向他问清楚再登记。',
      danger: 'reversible',
      roles: ['design'],
      schema: {
        reqId: z.string().describe('需求 id，形如 r_xxxx'),
        url: z.string().describe('Figma 链接'),
        label: z.string().optional().describe('这张稿的说明，如「默认态」「空态」'),
        pageId: z.string().optional().describe('页面 id（地图只有一页时可省略）'),
      },
      handler: async ({ reqId, url, label, pageId }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const req = r.req;

        const cleanUrl = String(url || '').trim();
        if (!cleanUrl || !/figma\.com\/|figma:/i.test(cleanUrl)) {
          return { error: '这看起来不是 Figma 链接，麻烦确认一下' };
        }

        const map = await readMapVersion(req);
        if (!map) return { error: `需求「${req.title}」还没有需求地图，设计稿暂时挂不上` };
        const pages = Array.isArray(map.pages) ? map.pages : [];

        let page = null;
        const wantPageId = String(pageId || '').trim();
        if (wantPageId) {
          page = pages.find((p) => p.id === wantPageId) || null;
          if (!page) return { error: `地图里没有页面「${wantPageId}」` };
        } else if (pages.length === 1) {
          page = pages[0];
        } else {
          // 页面清单对需求参与者本就可见；让模型问清再登记，比猜错页面强
          return { error: '地图有多个页面，先确认这张稿挂到哪一页', pages: pages.map((p) => ({ id: p.id, name: p.name })) };
        }

        const before = Array.isArray(page.figmas) ? page.figmas : [];
        const merged = await mergeFigmas(before, [...before, { url: cleanUrl, label: String(label || '').trim() }]);
        page.figmas = merged;
        await writeMapVersion(req, map);
        // 与 PUT /api/req/map/figma 路由同款审计注记
        updateRequirement(req.id, {}, `更新设计稿：${page.name}（${page.figmas.length} 张）`);

        // 追加项必在数组末尾（mergeFigmas 按 incoming 顺序产出），拿它的 id 作撤销锚点
        const added = merged[merged.length - 1];
        return {
          ok: true,
          reply: `已把设计稿登记到地图页「${page.name}」${label ? '（' + String(label).trim() + '）' : ''}`,
          __private: { pageId: page.id, figmaId: added?.id || null },
        };
      },
      buildUndo: (input, result) => ({
        kind: 'remove-figma',
        reqId: input.reqId,
        pageId: result?.__private?.pageId || null,
        figmaId: result?.__private?.figmaId || null,
      }),
    },
  ];
}
