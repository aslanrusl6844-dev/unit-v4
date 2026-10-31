/** Проверка формы Yandex Cloud: обязательные поля и обрезка пробелов (без БД). */
process.env.DATABASE_URL ??= 'postgresql://stub:stub@127.0.0.1:1/none';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yandexCloudSchema } from '../src/handlers/yandexCloudStore';

test('пустые и короткие значения отклоняются', () => {
  assert.equal(yandexCloudSchema.safeParse({ folderId: '', apiKey: '' }).success, false);
  assert.equal(yandexCloudSchema.safeParse({ folderId: 'b1g', apiKey: 'abcdefghij' }).success, false);
});

test('значения принимаются и обрезаются по краям', () => {
  const r = yandexCloudSchema.safeParse({ folderId: '  b1gabcdefgh  ', apiKey: '  AQVNabcdefghij  ' });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal(r.data.folderId, 'b1gabcdefgh');
    assert.equal(r.data.apiKey, 'AQVNabcdefghij');
  }
});

test('ID каталога в поле ключа отклоняется', () => {
  const same = yandexCloudSchema.safeParse({ folderId: 'b1gciogsa33dmnf17em9', apiKey: 'b1gciogsa33dmnf17em9' });
  assert.equal(same.success, false);
  const other = yandexCloudSchema.safeParse({ folderId: 'b1gciogsa33dmnf17em9', apiKey: 'b1gajuemtlkot03mrrjb' });
  assert.equal(other.success, false);
  assert.equal(yandexCloudSchema.safeParse({ folderId: 'b1gciogsa33dmnf17em9', apiKey: 'AQVNabcdefghijklmnopqrstuvwxyz0123456' }).success, true);
});
