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
