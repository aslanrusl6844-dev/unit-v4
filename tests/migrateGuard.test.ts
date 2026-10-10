import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decide } = require('../scripts/migrate-deploy.js');

test('Preview без подтверждения отдельной БД: миграции не запускаются', () => {
  assert.equal(decide({ VERCEL_ENV: 'preview' }).run, false);
  assert.equal(decide({ VERCEL_ENV: 'preview', PREVIEW_DB_CONFIRMED: '0' }).run, false);
  assert.equal(decide({ VERCEL_ENV: 'preview', PREVIEW_DB_CONFIRMED: 'true' }).run, false);
});
test('Preview с PREVIEW_DB_CONFIRMED=1: миграции запускаются', () => {
  assert.equal(decide({ VERCEL_ENV: 'preview', PREVIEW_DB_CONFIRMED: '1' }).run, true);
});
test('Production и локально: поведение прежнее (миграции запускаются), флаг не нужен', () => {
  assert.equal(decide({ VERCEL_ENV: 'production' }).run, true);
  assert.equal(decide({}).run, true);
  assert.equal(decide({ VERCEL_ENV: 'development' }).run, true);
});
test('скрипт в режиме Preview завершается успешно, ничего не запуская и не печатая строк подключения', () => {
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/migrate-deploy.js')], {
    env: { PATH: process.env.PATH, VERCEL_ENV: 'preview', DATABASE_URL: 'postgresql://u:SECRETPASS@h/db' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /миграции пропущены/);
  assert.equal((r.stdout + r.stderr).includes('SECRETPASS'), false);
});
