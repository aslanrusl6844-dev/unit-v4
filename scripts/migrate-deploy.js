#!/usr/bin/env node
/**
 * Применение миграций при сборке на Vercel.
 *
 * Production и локальный запуск: поведение прежнее — `prisma migrate deploy`.
 * Preview: миграции НЕ применяются, пока в настройках проекта явно не задано
 * PREVIEW_DB_CONFIRMED=1 (подтверждение, что DATABASE_URL/DIRECT_URL у Preview
 * указывают на ОТДЕЛЬНУЮ тестовую базу). Иначе сборка Preview могла бы изменить
 * боевую базу, если Preview и Production используют одну и ту же.
 * Строки подключения здесь не читаются и не печатаются.
 */
const { spawnSync } = require('node:child_process');

function decide(env) {
  if (env.VERCEL_ENV === 'preview' && env.PREVIEW_DB_CONFIRMED !== '1') {
    return { run: false, reason: 'Preview: миграции пропущены (PREVIEW_DB_CONFIRMED=1 не задано — отдельная тестовая база не подтверждена).' };
  }
  return { run: true, reason: '' };
}

if (require.main === module) {
  const d = decide(process.env);
  if (!d.run) {
    console.log('[migrate-deploy] ' + d.reason);
    process.exit(0);
  }
  const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(r.status === null ? 1 : r.status);
}

module.exports = { decide };
