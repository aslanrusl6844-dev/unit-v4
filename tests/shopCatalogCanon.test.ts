import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOP_CATEGORIES } from '../src/config/shopCategories';
import { SHOP_CATALOG_CANON, canonTypesOf } from '../src/config/shopCatalogCanon';
import { starterCatalogPairs, buildCatalog } from '../src/services/categoryHints';

test('справочник приложения покрывает ровно 23 раздела витрины и в том же порядке', () => {
  assert.deepEqual(Object.keys(SHOP_CATALOG_CANON), [...SHOP_CATEGORIES]);
  for (const c of SHOP_CATEGORIES) assert.ok(canonTypesOf(c).length > 0, `у раздела «${c}» нет типов`);
});

test('полки есть только у Обуви, Электроники, Автотоваров и Детских товаров; типы без повторов', () => {
  const withShelves = Object.entries(SHOP_CATALOG_CANON).filter(([, v]) => v.shelves.length).map(([k]) => k);
  assert.deepEqual(withShelves, ['Обувь', 'Электроника', 'Автотовары', 'Детские товары']);
  for (const c of SHOP_CATEGORIES) {
    const keys = canonTypesOf(c).map((t) => t.toLowerCase());
    assert.equal(new Set(keys).size, keys.length);
  }
  assert.deepEqual(SHOP_CATALOG_CANON['Обувь'].shelves.map((s) => s.title), ['Женская обувь', 'Мужская обувь', 'Детская обувь']);
});

test('стартовые пары каталога включают все типы приложения и прежние типы «Красоты»', () => {
  const cat = buildCatalog(starterCatalogPairs());
  const beauty = cat.find((c) => c.category === 'Красота и здоровье')!.types.map((t) => t.toLowerCase());
  assert.ok(beauty.includes('шампунь'));
  for (const c of SHOP_CATEGORIES) {
    const types = new Set(cat.find((x) => x.category === c)!.types.map((t) => t.toLowerCase()));
    for (const t of canonTypesOf(c)) assert.ok(types.has(t.toLowerCase()), `${c}: нет «${t}»`);
  }
});

test('в dashboard.js нет двух функций верхнего уровня с одним именем (вторая молча перекрывает первую)', () => {
  const src = readFileSync(join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
  const names = [...src.matchAll(/^(?:async )?function (\w+)\(/gm)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual([...new Set(dup)], []);
});
