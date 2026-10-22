/**
 * /api/credentials 多模型链路测试（spec `2026-10-08-credential-multi-model-design.md`）：
 * 添加不再要求 model；刷新模型列表走全局 fetch 桩（零网络）；legacy model 读侧回落为单模型列表。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-credentials-'));

const { handleCredentialsAdd, handleCredentialsList, handleCredentialsRefreshModels, handleCredentialsUpdate } = await import('./routes-settings.js');
const { getSettings, updateTokenMeta, addTokenEntry } = await import('../../store/settings.js');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function mockReq(body) {
  return Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]);
}
function mockRes() {
  const cap = { code: 0, body: null };
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code) {
      cap.code = code;
      res.headersSent = true;
    },
    end(text) {
      cap.body = text ? JSON.parse(text) : null;
    },
  };
  return { res, cap };
}
async function add(body) {
  const { res, cap } = mockRes();
  await handleCredentialsAdd(mockReq(body), res);
  return cap;
}
async function list() {
  const { res, cap } = mockRes();
  handleCredentialsList(res);
  return cap;
}
async function refresh(id) {
  const { res, cap } = mockRes();
  await handleCredentialsRefreshModels(mockReq(undefined), res, {
    pathname: `/api/credentials/${encodeURIComponent(id)}/refresh-models`,
  });
  return cap;
}
async function update(id, body) {
  const { res, cap } = mockRes();
  await handleCredentialsUpdate(mockReq(body), res, { pathname: `/api/credentials/${encodeURIComponent(id)}` });
  return cap;
}
const findCred = (l, id) => l.body.credentials.find((x) => x.id === id);

test('add：不再要求 model；返回 credential.id，list 可见（models 暂空）', async () => {
  const cap = await add({ label: 'DeepSeek', apiKey: 'sk-a', baseURL: 'https://api.deepseek.com/v1', vendor: 'deepseek' });
  assert.equal(cap.code, 200);
  const id = cap.body.credential?.id;
  assert.ok(id, '返回新建凭证 id（前端据此接着调 refresh-models）');
  const c = findCred(await list(), id);
  assert.equal(c.vendor, 'deepseek');
  assert.deepEqual(c.models, [], '尚未发现模型');
  assert.equal(c.model, '', '新链路不写 legacy model');
});

test('add：缺 apiKey / baseURL → 400；带 legacy model 仍兼容（读侧回落单模型）', async () => {
  assert.equal((await add({ apiKey: 'sk', baseURL: '' })).code, 400);
  assert.equal((await add({ apiKey: '', baseURL: 'https://x/v1' })).code, 400);
  const cap = await add({ label: '旧凭证', apiKey: 'sk-old', baseURL: 'https://api.zhipu.com/v1', model: 'glm-4' });
  const c = findCred(await list(), cap.body.credential.id);
  assert.deepEqual(c.models, [{ id: 'glm-4' }], 'legacy model 回落为单模型列表');
  assert.equal(c.model, 'glm-4', 'legacy 字段原样保留');
});

test('refresh-models：成功拉取并落盘（list 可见 + modelsUpdatedAt），apiKey 不回显', async () => {
  const cap = await add({ label: 'DS2', apiKey: 'sk-b', baseURL: 'https://api.deepseek.com/v1' });
  const id = cap.body.credential.id;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/v1/models');
    assert.equal(opts.headers.Authorization, 'Bearer sk-b');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }] }),
    };
  };
  const r = await refresh(id);
  assert.equal(r.code, 200);
  assert.equal(r.body.models.length, 2);
  const c = findCred(await list(), id);
  assert.deepEqual(c.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(c.models[0].name, 'DeepSeek V4.1 Flash');
  assert.ok(c.modelsUpdatedAt);
  assert.equal(JSON.stringify(c).includes('sk-b'), false, 'apiKey 不回显');
});

test('refresh-models：上游失败 → 502 人话错误；未知 id / 非 refresh 路径 → 404', async () => {
  const cap = await add({ label: 'DS3', apiKey: 'sk-c', baseURL: 'https://api.deepseek.com/v1' });
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const r = await refresh(cap.body.credential.id);
  assert.equal(r.code, 502);
  assert.match(r.body.error, /鉴权失败/);
  assert.equal((await refresh('tk_gone')).code, 404);

  const { res, cap: cap2 } = mockRes();
  await handleCredentialsRefreshModels(mockReq(undefined), res, { pathname: '/api/credentials/tk_x/whatever' });
  assert.equal(cap2.code, 404, '前缀下未识别的子路由 404，不误接');
});

test('update（修改凭证）：apiKey 可改（留空不动）；label 局部更新不动模型列表', async () => {
  const cap = await add({ label: '待改', apiKey: 'sk-old', baseURL: 'https://api.deepseek.com/v1', vendor: 'deepseek' });
  const id = cap.body.credential.id;
  updateTokenMeta(id, { models: [{ id: 'deepseek-chat' }], modelsUpdatedAt: 'T1' });

  // 只改 label：模型列表保留
  await update(id, { label: '改名了' });
  let c = findCred(await list(), id);
  assert.equal(c.label, '改名了');
  assert.deepEqual(c.models.map((m) => m.id), ['deepseek-chat']);

  // apiKey 留空 / 不传：token 不动（前端「留空 = 不修改」契约）
  await update(id, { label: '改名了', apiKey: '   ' });
  assert.equal(getSettings().tokens.find((t) => t.id === id).token, 'sk-old');

  // apiKey 有值：token 改写（列表不回显明文）
  await update(id, { apiKey: ' sk-new ' });
  const after = getSettings().tokens.find((t) => t.id === id);
  assert.equal(after.token, 'sk-new', 'apiKey 支持修改（trim 后写入）');
  assert.equal(JSON.stringify(await list()).includes('sk-new'), false, '列表不回显明文 apiKey');
});

test('update：baseURL / vendor 变更清空已发现模型（旧列表不对应新服务商）', async () => {
  const cap = await add({ label: 'DS-改网', apiKey: 'sk-d', baseURL: 'https://api.deepseek.com/v1', vendor: 'deepseek' });
  const id = cap.body.credential.id;
  updateTokenMeta(id, { models: [{ id: 'deepseek-chat' }], modelsUpdatedAt: 'T2' });

  await update(id, { baseURL: 'https://api.moonshot.cn/v1' });
  let c = findCred(await list(), id);
  assert.equal(c.baseURL, 'https://api.moonshot.cn/v1');
  assert.deepEqual(c.models, [], 'baseURL 变更后模型列表清空');
  assert.equal(c.modelsUpdatedAt, '');

  // vendor 变更同样清空（先补回列表）
  updateTokenMeta(id, { models: [{ id: 'moonshot-v1' }], modelsUpdatedAt: 'T3' });
  await update(id, { vendor: 'moonshot' });
  c = findCred(await list(), id);
  assert.deepEqual(c.models, [], 'vendor 变更后模型列表清空');
});

test('update：未知 id / Claude 凭证 id → 404，不误改订阅池', async () => {
  assert.equal((await update('tk_gone', { label: 'x' })).code, 404);
  const claude = addTokenEntry('订阅号', 'sk-ant-oat', undefined);
  const r = await update(claude.id, { label: '别改我' });
  assert.equal(r.code, 404, 'Claude 订阅凭证不属于 /api/credentials 管辖');
  assert.equal(getSettings().tokens.find((t) => t.id === claude.id).label, '订阅号');
});
