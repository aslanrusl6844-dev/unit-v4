/** Разбор ответа Яндекс Wordstat (topRequests) — без сети и БД. */
process.env.DATABASE_URL ??= 'postgresql://stub:stub@127.0.0.1:1/none';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWordstatTop, WORDSTAT_REGIONS } from '../src/services/wordstat.service';

test('результаты и похожие запросы, count строкой приводится к числу', () => {
  const r = mapWordstatTop(
    { totalCount: '12345', results: [{ phrase: 'наушники беспроводные', count: '900' }, { phrase: 'наушники', count: 12000 }], associations: [{ phrase: 'airpods', count: '50' }] },
    'наушники',
    'Казахстан',
  );
  assert.equal(r.total, 12345);
  assert.deepEqual(r.top, [{ phrase: 'наушники беспроводные', count: 900 }, { phrase: 'наушники', count: 12000 }]);
  assert.deepEqual(r.associations, [{ phrase: 'airpods', count: 50 }]);
  assert.equal(r.regionLabel, 'Казахстан');
});

test('незнакомый или пустой ответ — пустые списки, без падения', () => {
  for (const json of [{}, null, { results: 'x' }, { results: [{}] }]) {
    const r = mapWordstatTop(json, 'слово', 'Казахстан');
    assert.deepEqual(r.top, []);
    assert.deepEqual(r.associations, []);
  }
});

test('регионы Казахстана заданы', () => {
  assert.equal(WORDSTAT_REGIONS.KZ.id, '159');
  assert.ok(WORDSTAT_REGIONS['KZ-ALA'] && WORDSTAT_REGIONS['KZ-AST']);
});
