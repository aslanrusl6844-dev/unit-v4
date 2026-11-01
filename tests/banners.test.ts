import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCarouselSlot, nextCarouselSlot } from '../src/config/banners';

test('слоты карусели: 0..3 и 10+, особые 4..9 пропускаем', () => {
  assert.equal(isCarouselSlot(3), true);
  assert.equal(isCarouselSlot(4), false);
  assert.equal(isCarouselSlot(9), false);
  assert.equal(isCarouselSlot(10), true);
  assert.equal(nextCarouselSlot([0, 1, 2, 3, 4]), 10);
  assert.equal(nextCarouselSlot([0, 1, 2, 3, 4, 10, 11]), 12);
  assert.equal(nextCarouselSlot([]), 0);
});
