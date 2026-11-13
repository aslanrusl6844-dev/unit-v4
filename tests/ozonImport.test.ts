/** My Market → «Синхронизировать с Ozon»: добавляются только новые товары, существующие не трогаются. */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';

type Row = Record<string, any>;
let products: Row[] = [];
const dict = [{ ozonTypeKey: 'утюг', category: 'Бытовая техника', type: 'Утюги' }];

function matches(p: Row, w: Row): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === 'NOT') { if (matches(p, v as Row)) return false; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('not' in v && p[k] === (v as Row).not) return false;
      if ('gt' in v && !(p[k] > (v as Row).gt)) return false;
      if ('startsWith' in v && !String(p[k]).startsWith((v as Row).startsWith)) return false;
      continue;
    }
    if ((p[k] ?? null) !== v) return false;
  }
  return true;
}
class StubPrismaClient {
  constructor() {
    const stub: Row = {
      product: {
        findMany: async (a: Row) => products.filter((p) => matches(p, a.where)).sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, a.take),
        findUnique: async (a: Row) => products.find((p) => p.shopArticle === a.where.shopArticle) ?? null,
        updateMany: async (a: Row) => {
          const hit = products.filter((p) => matches(p, a.where));
          hit.forEach((p) => Object.assign(p, a.data));
          return { count: hit.length };
        },
      },
      ozonTypeMap: { findMany: async () => dict },
    };
    return new Proxy(this, { get(_t, key) { if (key === 'then') return undefined; return stub[key as string] ?? new Proxy({}, { get: () => async () => [] }); } });
  }
}
const prismaPath = require.resolve('@prisma/client');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { PrismaClient: StubPrismaClient, Prisma: {} } } as any;
const ozonPath = require.resolve(path.join(__dirname, '../src/integrations/ozon.client'));
require.cache[ozonPath] = {
  id: ozonPath, filename: ozonPath, loaded: true,
  exports: {
    ozonClient: {
      isConfigured: async () => true,
      fetchProductContent: async (ids: string[]) => ids.map((id) => ({ offerId: id, typeName: id === 'iron' ? 'Утюг' : 'Чайник', description: `Описание ${id}`, material: undefined })),
    },
  },
} as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { importOzonToMyMarket } = require('../src/services/ozonToMyMarket.service');

const base = { active: true, shopPrice: null, shopArticle: null, shopActive: false, shopArchived: false, shopStock: 0, images: null, category: null, type: null, categorySource: null, description: null, descriptionSource: null, ozonType: null };

beforeEach(() => {
  products = [
    { ...base, id: 'a1', sku: 'ozon-iron', name: 'Утюг 2400 Вт', ozonOfferId: 'iron', ozonReferencePrice: 15700.4, marketImages: '["https://ozon/iron.jpg"]' },
    { ...base, id: 'a2', sku: 'ozon-kettle', name: 'Чайник', ozonOfferId: 'kettle', ozonReferencePrice: 9990, marketImages: '["https://ozon/k.jpg"]' },
    { ...base, id: 'a3', sku: 'ozon-noprice', name: 'Без цены', ozonOfferId: 'noprice', ozonReferencePrice: null, marketImages: null },
    // Уже в My Market — своя цена, фото и категория: не трогаем.
    { ...base, id: 'a4', sku: 'ozon-old', name: 'Старый', ozonOfferId: 'old', ozonReferencePrice: 5000, shopPrice: 4500, shopArticle: '1234567', shopActive: true, images: '["https://my/own.jpg"]', category: 'Дом', type: 'Вазы', marketImages: '["https://ozon/old.jpg"]' },
    // Скрыт на Ozon — не переносим.
    { ...base, id: 'a5', sku: 'ozon-off', name: 'Снят с продажи', ozonOfferId: 'off', ozonReferencePrice: 1000, active: false },
    // Не с Ozon.
    { ...base, id: 'a6', sku: 'mm-1', name: 'Свой', ozonOfferId: null, ozonReferencePrice: null },
  ];
});

describe('Синхронизировать с Ozon', () => {
  test('добавляет только новые товары с фото, ценой и категорией по словарю', async () => {
    const r = await importOzonToMyMarket(40);
    assert.equal(r.added, 2);
    assert.equal(r.addedWithoutCategory, 1);
    assert.equal(r.skippedNoPrice, 1);
    assert.deepEqual(r.unmappedTypes, ['Чайник']);
    assert.equal(r.done, true);

    const iron = products.find((p) => p.id === 'a1')!;
    assert.equal(iron.shopPrice, 15700);
    assert.match(iron.shopArticle, /^\d{7}$/);
    assert.equal(iron.shopActive, false);
    assert.equal(iron.images, '["https://ozon/iron.jpg"]');
    assert.equal(iron.category, 'Бытовая техника');
    assert.equal(iron.type, 'Утюги');
    assert.equal(iron.categorySource, 'dictionary');
    assert.equal(iron.description, 'Описание iron');

    const kettle = products.find((p) => p.id === 'a2')!;
    assert.equal(kettle.shopPrice, 9990);
    assert.equal(kettle.category, null); // → «Без категории»
  });

  test('существующий товар My Market не меняется ни в чём', async () => {
    const before = JSON.stringify(products.find((p) => p.id === 'a4'));
    await importOzonToMyMarket(40);
    assert.equal(JSON.stringify(products.find((p) => p.id === 'a4')), before);
    assert.equal(products.find((p) => p.id === 'a5')!.shopPrice, null);
    assert.equal(products.find((p) => p.id === 'a6')!.shopPrice, null);
  });

  test('повторный запуск ничего не добавляет', async () => {
    await importOzonToMyMarket(40);
    const again = await importOzonToMyMarket(40);
    assert.equal(again.added, 0);
  });

  test('пачками: курсор идёт дальше', async () => {
    const first = await importOzonToMyMarket(1);
    assert.equal(first.done, false);
    assert.equal(first.added, 1);
    const second = await importOzonToMyMarket(1, first.nextCursor);
    assert.equal(second.added, 1);
  });
});
