import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const { rankProducts, extractSkus, diverseSample, streamClaude } = require('../src/services/assistant.service');
const { sanitizeMessages } = require('../src/routes/assistant.routes');

const items = [
  { sku: '1', name: 'Платье летнее красное', category: 'Женская одежда', subcategory: 'Платья', type: null, price: 100, image: null },
  { sku: '2', name: 'Кроссовки белые', category: 'Обувь', subcategory: null, type: null, price: 200, image: null },
];

test('rankProducts находит по словоформе', () => {
  assert.equal(rankProducts(items, 'ищу платья')[0].sku, '1');
  assert.deepEqual(rankProducts(items, 'телевизор'), []);
});

test('extractSkus берёт {{артикул}} и пропускает витрины', () => {
  assert.deepEqual(extractSkus('Смотрите {{1}} и {{ 2 }} и {{витрина:abc}}'), ['1', '2']);
  assert.equal(diverseSample([...items, ...items, ...items], 12).length, 4);
});

test('sanitizeMessages обрезает и начинает с user', () => {
  const m = sanitizeMessages([{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'x'.repeat(5000) }]);
  assert.equal(m.length, 1);
  assert.equal(m[0].content.length, 2000);
});

test('streamClaude разбирает SSE', async () => {
  const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"При"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"вет"}}\n\n';
  const fake: any = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), { status: 200 });
  const got: string[] = [];
  const full = await streamClaude({ apiKey: 'k', model: 'm', system: 's', messages: [{ role: 'user', content: 'a' }], onDelta: (t) => got.push(t), fetchImpl: fake });
  assert.equal(full, 'Привет');
  assert.deepEqual(got, ['При', 'вет']);
});
