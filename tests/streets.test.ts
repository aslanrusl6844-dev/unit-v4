import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const { streetKey, parseOverpassNames, rankStreets, buildOverpassQuery, fetchCityStreets } = require('../src/services/streets.service');

test('streetKey убирает «улица/проспект» и регистр', () => {
  assert.equal(streetKey('улица Абая'), 'абая');
  assert.equal(streetKey('Проспект Аль-Фараби'), 'аль фараби');
  assert.equal(streetKey('мкр Самал-2'), 'самал 2');
  assert.equal(streetKey('Ёлочная улица'), 'елочная');
});

test('parseOverpassNames: без повторов, цифр и мусора, предпочитает name:ru', () => {
  const names = parseOverpassNames({ elements: [
    { tags: { name: 'улица Абая' } }, { tags: { name: 'улица Абая' } }, { tags: { name: '12' } },
    { tags: { name: 'Абай көшесі', 'name:ru': 'улица Абая 2' } }, { tags: {} }, { tags: { name: 'x' } },
  ] });
  assert.deepEqual(names, ['улица Абая', 'улица Абая 2']);
});

test('rankStreets: начало названия выше, короткий запрос — пусто', () => {
  const rows = ['улица Абая', 'улица Байтурсынова', 'проспект Абылай хана', 'улица Жамбыла'].map((name) => ({ name, key: streetKey(name) }));
  assert.deepEqual(rankStreets(rows, 'аб'), ['улица Абая', 'проспект Абылай хана']);
  assert.deepEqual(rankStreets(rows, 'а'), []);
  assert.deepEqual(rankStreets(rows, 'улица абая'), ['улица Абая']);
});

test('запрос Overpass содержит город, а зеркало подхватывается при сбое', async () => {
  assert.match(buildOverpassQuery('Усть-Каменогорск'), /\^Усть-Каменогорск\$/);
  const urls: string[] = [];
  const f: any = async (u: string) => {
    urls.push(u);
    return u.includes('overpass-api.de')
      ? new Response('busy', { status: 429 })
      : new Response(JSON.stringify({ elements: [{ tags: { name: 'улица Абая' } }] }), { status: 200 });
  };
  assert.deepEqual(await fetchCityStreets('Алматы', f), ['улица Абая']);
  assert.equal(urls.length, 2);
});
