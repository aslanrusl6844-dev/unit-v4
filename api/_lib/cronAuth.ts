import type { VercelRequest } from '@vercel/node';

/**
 * Папка api/_lib/ с префиксом "_" — служебная: Vercel по своей же
 * конвенции НЕ создаёт из таких файлов отдельные маршруты (в отличие от
 * обычных файлов в api/), так что этот файл безопасно импортировать как
 * простой модуль с кодом, а не как случайный дополнительный эндпоинт.
 */
export function checkCronSecret(req: VercelRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  // Вариант 1: сам Vercel Cron автоматически шлёт "Authorization: Bearer <CRON_SECRET>".
  const authHeader = req.headers['authorization'];
  if (authHeader === `Bearer ${expected}`) return true;

  // Вариант 2: внешний планировщик (cron-job.org и т.п.) — секрет через query.
  const querySecret = req.query.secret;
  return querySecret === expected;
}
