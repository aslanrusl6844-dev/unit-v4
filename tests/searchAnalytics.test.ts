/**
 * Тесты раздела «Аналитика запросов»: разбор ответов Google Trends и подсчёт
 * «Моих продаж» по слову (БД подменена заглушкой, сеть не используется).
 */
process.env.DATABASE_URL ??= 'postgresql://stub:stub@127.0.0.1:1/none';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getMySalesByKeyword, mapRelated, mapTimeline, parseTrendsJson } from '../src/services/searchAnalytics.service';

describe('Google Trends: разбор', () => {
  test('HTML вместо JSON → понятная ошибка', () => {
    assert.throws(() => parseTrendsJson('<html>429</html>', 'динамика'), /не JSON/);
  });
  test('таймлайн приводится к датам и значениям', () => {
    const json = parseTrendsJson<any>(
      JSON.stringify({ default: { timelineData: [{ time: '1759276800', value: [40] }, { time: '1761955200', value: [100] }] } }),
      'x',
    );
    const t = mapTimeline(json);
    assert.equal(t.length, 2);
    assert.equal(t[1].value, 100);
    assert.match(t[0].date, /^2025-10-0[1-2]$/);
  });
  test('связанные запросы: топ и растущие', () => {
    const r = mapRelated({
      default: {
        rankedList: [
          { rankedKeyword: [{ query: 'куртка женская зимняя', value: 100 }] },
          { rankedKeyword: [{ query: 'пуховик', value: 5000, formattedValue: '+5 000%' }] },
        ],
      },
    });
    assert.deepEqual(r.top, [{ query: 'куртка женская зимняя', value: 100 }]);
    assert.deepEqual(r.rising, [{ query: 'пуховик', value: '+5 000%' }]);
  });
  test('пустой ответ → пустые списки', () => {
    assert.deepEqual(mapTimeline({}), []);
    assert.deepEqual(mapRelated({}), { top: [], rising: [] });
  });
});

describe('Мои продажи по слову', () => {
  test('сумма по месяцам и площадкам, пустые месяцы остаются', async () => {
    const fakeDb = {
      orderItem: {
      findMany: async () => [
        { name: 'Куртка женская', quantity: 2, price: 10000, order: { marketplace: 'KASPI', orderDate: new Date('2026-08-10T10:00:00') } },
        { name: 'Куртка женская', quantity: 1, price: 12000, order: { marketplace: 'OZON', orderDate: new Date('2026-08-20T10:00:00') } },
        { name: 'Куртка мужская', quantity: 3, price: 9000, order: { marketplace: 'KASPI', orderDate: new Date('2026-10-05T10:00:00') } },
      ],
      },
    };
    const r = await getMySalesByKeyword('куртка', new Date('2026-08-01T00:00:00'), new Date('2026-10-31T23:59:59'), fakeDb);
    assert.deepEqual(r.months.map((m) => m.month), ['2026-08', '2026-09', '2026-10']);
    assert.equal(r.months[0].quantity, 3);
    assert.equal(r.months[0].revenue, 32000);
    assert.equal(r.months[1].quantity, 0);
    assert.equal(r.totals.KASPI?.quantity, 5);
    assert.equal(r.totals.OZON?.revenue, 12000);
    assert.equal(r.totals.all.revenue, 59000);
    assert.equal(r.topProducts[0].name, 'Куртка женская');
    assert.equal(r.truncated, false);
  });
});
