/** image-attachments.logic 单测：附件归一 / 魔数嗅探 / 模型边界内联（注入 IO，零磁盘） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAttachments,
  guessImageMime,
  isImagePath,
  inlineImageAttachments,
  MAX_IMAGES_PER_REQUEST,
} from './image-attachments.logic.js';

const pngBuf = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);
const jpegBuf = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8, 1)]);
const textBuf = () => Buffer.from('not an image at all', 'utf8');

const readOf = (files) => async (p) => {
  if (!(p in files)) throw new Error('ENOENT');
  return files[p];
};
const statOf = (sizes) => async (p) => {
  if (!(p in sizes)) throw new Error('ENOENT');
  return { size: sizes[p], isDirectory: () => false };
};

test('normalizeAttachments：字符串/对象混入、去空、去重（win 大小写）、限量、name 回落 basename', () => {
  const out = normalizeAttachments([
    { path: ' C:/tmp/a.png ', name: '截图' },
    'C:/tmp/b.pdf',
    { path: 'C:/tmp/A.PNG' }, // win 下与第一条同路径（大小写），去重——Linux CI 视为不同
    { path: '' },
    null,
    42,
  ]);
  const paths = out.map((a) => a.path);
  assert.ok(paths.includes('C:/tmp/a.png'));
  assert.ok(paths.includes('C:/tmp/b.pdf'));
  assert.equal(out.find((a) => a.path === 'C:/tmp/a.png').name, '截图');
  assert.equal(out.find((a) => a.path === 'C:/tmp/b.pdf').name, 'b.pdf');
  assert.equal(out.length, process.platform === 'win32' ? 2 : 3);
  assert.equal(normalizeAttachments(Array.from({ length: 20 }, (_, i) => `x/${i}.png`), { max: 3 }).length, 3);
  assert.deepEqual(normalizeAttachments(null), []);
});

test('guessImageMime / isImagePath：按魔数判类型，扩展名只作提示', () => {
  assert.equal(guessImageMime(pngBuf()), 'image/png');
  assert.equal(guessImageMime(jpegBuf()), 'image/jpeg');
  assert.equal(guessImageMime(Buffer.from('GIF89a......', 'ascii')), 'image/gif');
  assert.equal(guessImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])), 'image/webp');
  assert.equal(guessImageMime(Buffer.from('BM....', 'ascii')), 'image/bmp');
  assert.equal(guessImageMime(textBuf()), null);
  assert.equal(guessImageMime(null), null);
  assert.equal(isImagePath('C:/a/b.PNG'), true);
  assert.equal(isImagePath('C:/a/b.pdf'), false);
});

test('inlineImageAttachments：无 readFile 注入 → 原引用返回（fail-safe 不猜）', async () => {
  const msgs = [{ role: 'user', content: '看图', attachments: [{ path: 'a.png', name: 'a.png' }] }];
  const r = await inlineImageAttachments(msgs);
  assert.equal(r.messages, msgs);
  assert.deepEqual(r.inlined, []);
});

test('inlineImageAttachments：图片 → [text, file part]，剥掉 attachments；非图片附件静默放行', async () => {
  const msgs = [
    { role: 'user', content: '这张图里是什么？', attachments: [{ path: 'C:/tmp/a.png', name: 'a.png' }, { path: 'C:/tmp/doc.pdf', name: 'doc.pdf' }] },
    { role: 'assistant', content: '看看' },
  ];
  const r = await inlineImageAttachments(msgs, {
    readFile: readOf({ 'C:/tmp/a.png': pngBuf(20), 'C:/tmp/doc.pdf': textBuf() }),
    statFile: statOf({ 'C:/tmp/a.png': 28, 'C:/tmp/doc.pdf': 18 }),
  });
  const [img, asst] = r.messages;
  assert.equal(asst, msgs[1], '无关消息保持原引用');
  assert.ok(Array.isArray(img.content), '带图消息 content 变为 part 数组');
  assert.deepEqual(img.content[0], { type: 'text', text: '这张图里是什么？' });
  assert.equal(img.content[1].type, 'file');
  assert.equal(img.content[1].mediaType, 'image/png');
  assert.ok(Buffer.isBuffer(img.content[1].data));
  assert.ok(!('attachments' in img), 'attachments 是本地账，不进模型视图');
  assert.equal(r.inlined.length, 1);
  assert.deepEqual(r.inlined[0], { path: 'C:/tmp/a.png', name: 'a.png', mime: 'image/png', bytes: 28 });
  assert.deepEqual(r.skipped, [], 'pdf 不是图片：不产生噪音');
  assert.equal(msgs[0].content, '这张图里是什么？', '原消息不被修改');
});

test('inlineImageAttachments：扩展名像图片但内容不是 → skipped 一条；读取失败同理', async () => {
  const msgs = [
    {
      role: 'user',
      content: '两个附件',
      attachments: [
        { path: 'C:/tmp/fake.png', name: 'fake.png' },
        { path: 'C:/tmp/missing.jpg', name: 'missing.jpg' },
      ],
    },
  ];
  const r = await inlineImageAttachments(msgs, { readFile: readOf({ 'C:/tmp/fake.png': textBuf() }) });
  assert.deepEqual(r.inlined, []);
  assert.deepEqual(
    r.skipped.map((s) => [s.name, s.reason]).sort(),
    [
      ['fake.png', '不是有效图片'],
      ['missing.jpg', '文件不存在或不可读'],
    ],
  );
  assert.equal(r.messages[0].content, '两个附件');
  assert.ok(!('attachments' in r.messages[0]));
});

test('inlineImageAttachments：单图超限（stat 先拦）→ skipped；预算按张数收口', async () => {
  const msgs = [
    {
      role: 'user',
      content: '三张图',
      attachments: [
        { path: 'C:/tmp/big.png', name: 'big.png' },
        { path: 'C:/tmp/1.png', name: '1.png' },
        { path: 'C:/tmp/2.png', name: '2.png' },
      ],
    },
  ];
  const r = await inlineImageAttachments(msgs, {
    readFile: readOf({ 'C:/tmp/1.png': pngBuf(4), 'C:/tmp/2.png': pngBuf(4) }),
    statFile: statOf({ 'C:/tmp/big.png': 99 * 1024 * 1024, 'C:/tmp/1.png': 12, 'C:/tmp/2.png': 12 }),
    maxImages: 1,
    maxImageBytes: 2 * 1024 * 1024,
  });
  assert.equal(r.inlined.length, 1);
  assert.equal(r.inlined[0].name, '1.png');
  assert.deepEqual(
    r.skipped.map((s) => s.reason),
    ['超过单张上限（2MB）', '超过本轮图片数量上限（1 张）'],
  );
});

test('inlineImageAttachments：只回溯最近 maxMessages 条带附件消息；同图去重；cache 只读一次盘', async () => {
  const msgs = [
    { role: 'user', content: '老图', attachments: [{ path: 'C:/tmp/old.png', name: 'old.png' }] },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '新图', attachments: [{ path: 'C:/tmp/new.png', name: 'new.png' }] },
    { role: 'user', content: '同一张再来', attachments: [{ path: 'C:/tmp/new.png', name: 'new.png' }] },
  ];
  let reads = 0;
  const files = { 'C:/tmp/old.png': pngBuf(2), 'C:/tmp/new.png': pngBuf(2) };
  const readFile = async (p) => (reads++, readOf(files)(p));
  const cache = new Map();
  const r = await inlineImageAttachments(msgs, { readFile, cache, maxMessages: 2 });
  assert.equal(typeof r.messages[0].content, 'string', '更早的带图消息只留文本');
  assert.ok(!('attachments' in r.messages[0]));
  assert.equal(r.inlined.length, 1, '同一张图只发一次');
  assert.equal(r.inlined[0].path, 'C:/tmp/new.png');
  // 第 3、4 条都引用 new.png：去重后只读一次
  assert.equal(reads, 1);
  // 第二次调用（模拟下一步）：cache 命中，不再读盘
  await inlineImageAttachments(msgs, { readFile, cache, maxMessages: 2 });
  assert.equal(reads, 1);
  assert.equal(MAX_IMAGES_PER_REQUEST, 4, '默认张数上限是契约的一部分（改动需同步 spec）');
});
