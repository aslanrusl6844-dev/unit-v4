import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayMode } from '../src/services/productExtras';

const H = { front: 'https://x/f.png', side: 'https://x/s.png', back: 'https://x/b.png' };

test('режим показа: без выбора — вешалка, если есть 3 фото', () => {
  assert.equal(resolveDisplayMode({ hanger: H }), 'hanger');
  assert.equal(resolveDisplayMode({ hanger: { front: H.front } }), 'card');
  assert.equal(resolveDisplayMode({}), 'card');
});

test('режим показа: полочка только с фото', () => {
  assert.equal(resolveDisplayMode({ displayMode: 'shelf', shelfImage: 'https://x/shoe.png' }), 'shelf');
  assert.equal(resolveDisplayMode({ displayMode: 'shelf', shelfImage: null, hanger: H }), 'card');
});

test('режим показа: явная обычная карточка важнее фото вешалки', () => {
  assert.equal(resolveDisplayMode({ displayMode: 'card', hanger: H }), 'card');
  assert.equal(resolveDisplayMode({ displayMode: 'hanger', hanger: H }), 'hanger');
});
