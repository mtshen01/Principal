import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostTool, NOTIFY_HOST } from './host.js';

function make(extra = {}) {
  const sent = [];
  const tool = buildHostTool({
    getMyFeishuOpenId: () => 'ou_host',
    getActiveBot: () => ({ id: 'bot_1', appId: 'a', appSecret: 's' }),
    sendText: async (openId, text) => sent.push({ openId, text }),
    ...extra,
  });
  return { tool, sent };
}

test('notify_host：定义形状（notify 档 + 全员可见）', () => {
  const { tool } = make();
  assert.equal(tool.name, NOTIFY_HOST);
  assert.equal(tool.danger, 'notify');
  assert.deepEqual(tool.roles, ['*']);
});

test('notify_host：成功 → 发给主机的 open_id，署名（同事名 + 职位）由服务端前置', async () => {
  const { tool, sent } = make();
  const out = await tool.handler({ text: '产品说这个需求想下周上线' }, { colleagueName: '张三', roleLabel: '产品' });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, 'ou_host');
  assert.equal(sent[0].text, '[张三（产品）] 产品说这个需求想下周上线');
});

test('notify_host：缺署名上下文时不炸，用「同事」兜底', async () => {
  const { tool, sent } = make();
  await tool.handler({ text: 'x' }, {});
  assert.match(sent[0].text, /^\[同事（同事）\]/);
});

test('notify_host：空正文 → error，不发送', async () => {
  const { tool, sent } = make();
  const out = await tool.handler({ text: '  ' }, {});
  assert.ok(out.error);
  assert.equal(sent.length, 0);
});

test('notify_host：主机未配置 open_id → error，不发送', async () => {
  const { tool, sent } = make({ getMyFeishuOpenId: () => '' });
  const out = await tool.handler({ text: 'x' }, {});
  assert.match(out.error, /open_id/);
  assert.equal(sent.length, 0);
});

test('notify_host：发送失败 → error（不谎报已转达）', async () => {
  const { tool } = make({
    sendText: async () => {
      throw new Error('lark boom');
    },
  });
  const out = await tool.handler({ text: 'x' }, {});
  assert.ok(out.error);
  assert.notEqual(out.ok, true);
});

test('notify_host：超长正文截断到 1000', async () => {
  const { tool, sent } = make();
  await tool.handler({ text: 'x'.repeat(2000) }, {});
  assert.equal(sent[0].text.length, '[同事（同事）] '.length + 1000);
});
