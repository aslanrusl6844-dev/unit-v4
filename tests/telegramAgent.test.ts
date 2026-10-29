import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrices, extractJson, detailsSchema } from '../src/services/productAgent.service';

test('parsePrices', () => {
  assert.deepEqual(parsePrices('4500 / 6000'), { price: 4500, oldPrice: 6000 });
  assert.deepEqual(parsePrices('цена 4 500, старая 6 000'), { price: 4500, oldPrice: 6000 });
  assert.deepEqual(parsePrices('3990'), { price: 3990, oldPrice: undefined });
  assert.deepEqual(parsePrices('5000 3000'), { price: 5000, oldPrice: undefined });
  assert.deepEqual(parsePrices('без цифр'), {});
});

test('extractJson + schema', () => {
  const j = extractJson('вот:\n```json\n{"name":"Крем","category":"Красота","type":"Крем","description":"ок"}\n```');
  assert.equal((j as any).name, 'Крем');
  assert.throws(() => extractJson('нет'));
  assert.equal(detailsSchema.safeParse({ name: 'Крем', category: 'нет такой', type: 'x', description: '' }).success, false);
});

test('parseAttachCommand', async () => {
  const { parseAttachCommand } = await import('../src/services/productDraft.service');
  assert.equal(parseAttachCommand('детали 1234567'), '1234567');
  assert.equal(parseAttachCommand('Детали крем для рук'), 'крем для рук');
  assert.equal(parseAttachCommand('4500 / 6000'), null);
});

test('generateScene: разбор ответа Gemini и ошибки', async () => {
  const { generateScene, buildScenePrompt } = await import('../src/services/geminiImage.service');
  const png = Buffer.from('89504e47', 'hex');
  let sent: any;
  const ok = (async (url: string, init: any) => {
    sent = { url, body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }), { status: 200 });
  }) as any;
  const r = await generateScene({ apiKey: 'K', refs: [{ data: png, mime: 'image/jpeg' }], scene: 'marble table', fetchImpl: ok });
  assert.equal(r.mime, 'image/png');
  assert.deepEqual(r.data, png);
  assert.equal(sent.key, 'K');
  assert.match(sent.url, /gemini-2\.5-flash-image:generateContent$/);
  assert.equal(sent.body.generationConfig.imageConfig.aspectRatio, '3:4');
  assert.match(buildScenePrompt('x'), /Do NOT add any extra text/);
  const bad = (async () => new Response('{"error":"quota"}', { status: 429 })) as any;
  await assert.rejects(generateScene({ apiKey: 'K', refs: [], scene: 's', fetchImpl: bad }), /Gemini 429/);
  const empty = (async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'no' }] } }] }), { status: 200 })) as any;
  await assert.rejects(generateScene({ apiKey: 'K', refs: [], scene: 's', fetchImpl: empty }), /не вернул картинку \(SAFETY\)/);
});

test('generateSceneAuto: порядок провайдеров и запасной', async () => {
  const { generateSceneAuto } = await import('../src/services/geminiImage.service');
  const png = Buffer.from('89504e47', 'hex');
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url.includes('openai') ? 'openai' : 'gemini');
    if (url.includes('generativelanguage')) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
  }) as any;
  const r = await generateSceneAuto({ refs: [{ data: png, mime: 'image/jpeg' }], scene: 's', fetchImpl: f, env: { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' } as any });
  assert.deepEqual(calls, ['gemini', 'openai']);
  assert.deepEqual(r.data, png);
  calls.length = 0;
  await generateSceneAuto({ refs: [], scene: 's', fetchImpl: f, env: { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', IMAGE_PROVIDER: 'openai' } as any });
  assert.deepEqual(calls, ['openai']);
  await assert.rejects(generateSceneAuto({ refs: [], scene: 's', env: {} as any }), /нет ключей/);
});
