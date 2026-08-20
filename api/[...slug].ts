import type { VercelRequest, VercelResponse } from '@vercel/node';
// Исходники в src/ не используют алиасы путей (все импорты — обычные
// относительные пути), поэтому Vercel не может неправильно их развернуть.
// Тем не менее здесь мы подключаем не "сырые" .ts из src/, а уже собранный
// JavaScript из dist/ — он создаётся во время сборки на Vercel командой
// "npm run build" (см. buildCommand в vercel.json), до того как Vercel
// начинает искать и собирать функции в api/, так что к моменту сборки
// этой функции dist/ уже гарантированно существует.
import app from '../dist/expressApp';
import { runOrderSync, runReprice } from '../dist/cron/handlers';

/**
 * Единая serverless-функция для всех запросов на /api/* (файл называется
 * [...slug].ts — это "catch-all" маршрут Vercel, ловит любой путь под /api/).
 *
 * Два специальных пути (/api/cron/sync и /api/cron/reprice) обрабатываются
 * прямо здесь и защищены секретным токеном. Всё остальное передаётся в
 * обычное Express-приложение (src/expressApp.ts) — там уже все "настоящие"
 * роуты дашборда (товары, заказы, аналитика и т.д.), без каких-либо изменений.
 */

function checkCronSecret(req: VercelRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  // Вариант 1: сам Vercel Cron автоматически шлёт "Authorization: Bearer <CRON_SECRET>",
  // если переменная окружения называется именно CRON_SECRET.
  const authHeader = req.headers['authorization'];
  if (authHeader === `Bearer ${expected}`) return true;

  // Вариант 2: внешний планировщик (например, cron-job.org) — передаём секрет
  // через query-параметр, т.к. не все бесплатные сервисы умеют слать заголовки.
  const querySecret = req.query.secret;
  return querySecret === expected;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = req.url || '';

  if (url.startsWith('/api/cron/sync')) {
    if (!checkCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await runOrderSync();
      return res.status(200).json({ ok: true, result });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  }

  if (url.startsWith('/api/cron/reprice')) {
    if (!checkCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const results = await runReprice();
      return res.status(200).json({ ok: true, results });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  }

  // Всё остальное (/api/products, /api/orders, /api/kaspi/price-feed.xml и т.д.)
  // обрабатывает обычное Express-приложение — оно само знает свои маршруты.
  return app(req as any, res as any);
}
