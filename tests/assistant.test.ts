import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const { rankProducts, extractSkus, diverseSample, matchShowcases, streamClaude } = require('../src/services/assistant.service');
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

test('matchShowcases находит бренд по названию', () => {
  const sc = [
    { id: 'a', title: 'Sellers', type: 'brand', description: null, count: 3 },
    { id: 'b', title: '9-9', type: 'brand', description: null, count: 2 },
  ];
  assert.deepEqual(matchShowcases(sc, 'что есть у Sellers для лица?').map((x: any) => x.id), ['a']);
  assert.deepEqual(matchShowcases(sc, 'крем 9-9 есть?').map((x: any) => x.id), ['b']);
  assert.deepEqual(matchShowcases(sc, 'мне нужно 99 штук').map((x: any) => x.id), []);
});

test('rankProducts учитывает бренд витрины', () => {
  const it = [{ sku: '5', name: 'Крем', category: 'Красота', subcategory: null, type: null, price: 1, image: null, showcases: ['Sellers'] }, items[1]];
  assert.equal(rankProducts(it, 'sellers')[0].sku, '5');
});

const { looseKey, findShowcase, toolGetShowcase, toolSearchProducts, runAssistant } = require('../src/services/assistant.service');

const cell = { id: 'sc1', title: 'CELL 29', type: 'brand', description: null, count: 18 };
const nike = { id: 'sc2', title: 'NIKE', type: 'brand', description: null, count: 2 };
const many = Array.from({ length: 18 }, (_, i) => ({
  sku: `C${i + 1}`, name: `Товар ${i + 1}`, category: 'Красота', subcategory: null, type: null, price: 1000 + i, image: null,
  stock: 5, details: `описание: польза ${i + 1}`, showcases: ['CELL 29'],
}));
const catalog = { items: [...many, { sku: 'N1', name: 'Кроссовки', category: 'Обувь', subcategory: null, type: null, price: 9000, image: null, stock: 1, showcases: ['NIKE'] }], showcases: [cell, nike] };

test('«Цель-29» на слух = CELL 29', () => {
  assert.equal(looseKey('Цель-29'), looseKey('CELL 29'));
  assert.deepEqual(matchShowcases([cell, nike], 'в Цель-29 какие есть товары').map((x: any) => x.id), ['sc1']);
  assert.equal(findShowcase([cell, nike], 'цель 29')?.id, 'sc1');
  assert.equal(findShowcase([cell, nike], 'sc2')?.id, 'sc2');
  assert.equal(findShowcase([cell, nike], 'Адидас'), null);
});

test('get_showcase отдаёт ВСЕ 18 товаров витрины, не 5', () => {
  const out = toolGetShowcase(catalog, 'Цель-29');
  assert.match(out, /товаров всего: 18/);
  assert.equal(out.split('\n').filter((l: string) => l.startsWith('- ')).length, 18);
  assert.match(toolGetShowcase(catalog, 'Адидас'), /не найдена. Есть витрины: CELL 29, NIKE/);
  assert.match(toolSearchProducts(catalog, 'кроссовки'), /N1/);
});

test('runAssistant: Claude вызывает get_showcase, получает 18 товаров и пишет ответ', async () => {
  const enc = new TextEncoder();
  const sse = (events: any[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const rounds = [
    sse([
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'get_showcase' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"showcase":' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"CELL 29"}' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]),
    sse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'В CELL 29 18 товаров: {{C1}}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]),
  ];
  const bodies: any[] = [];
  let n = 0;
  const fake: any = async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const data = rounds[n++];
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(data)); c.close(); } }), { status: 200 });
  };
  const got: string[] = [];
  const full = await runAssistant({ apiKey: 'k', model: 'm', system: 's', messages: [{ role: 'user', content: 'что в Цель-29?' }], catalog, onDelta: (t: string) => got.push(t), fetchImpl: fake });
  assert.equal(full, 'В CELL 29 18 товаров: {{C1}}');
  assert.equal(n, 2);
  assert.equal(bodies[0].tools.length, 2);
  const toolResult = bodies[1].messages[2].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 't1');
  assert.match(toolResult.content, /товаров всего: 18/);
  assert.equal(bodies[1].messages[1].content[0].name, 'get_showcase');

const { transcribeAudio, cleanTranscript, audioMime } = require('../src/services/speechToText.service');

test('cleanTranscript и audioMime', () => {
  assert.equal(cleanTranscript('  «Привет,   мир» \n'), 'Привет, мир');
  assert.equal(audioMime('audio/mp4; codecs=mp4a'), 'audio/mp4');
  assert.equal(audioMime('application/json'), 'audio/mp4');
});

test('transcribeAudio: Gemini разбирает ответ; при сбое — запасной OpenAI', async () => {
  const audio = Buffer.alloc(2000, 1);
  const gem: any = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Что есть в Цель-29' }] } }] }), { status: 200 });
  assert.equal(await transcribeAudio({ audio, mime: 'audio/mp4', env: { GEMINI_API_KEY: 'g' } as any, fetchImpl: gem }), 'Что есть в Цель-29');

  const calls: string[] = [];
  const mixed: any = async (url: string) => {
    calls.push(url);
    return url.includes('googleapis') ? new Response('boom', { status: 500 }) : new Response(JSON.stringify({ text: 'привет' }), { status: 200 });
  };
  assert.equal(await transcribeAudio({ audio, mime: 'audio/mp4', env: { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' } as any, fetchImpl: mixed }), 'привет');
  assert.equal(calls.length, 2);
  await assert.rejects(transcribeAudio({ audio, mime: 'audio/mp4', env: {} as any }), /Нет ключей/);
});
