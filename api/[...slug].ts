import type { VercelRequest, VercelResponse } from '@vercel/node';
// Исходники в src/ не используют алиасы путей (все импорты — обычные
// относительные пути), поэтому Vercel не может неправильно их развернуть.
// Тем не менее здесь мы подключаем не "сырые" .ts из src/, а уже собранный
// JavaScript из dist/ — он создаётся во время сборки на Vercel командой
// "npm run build" (см. buildCommand в vercel.json), до того как Vercel
// начинает искать и собирать функции в api/, так что к моменту сборки
// этой функции dist/ уже гарантированно существует.
import app from '../dist/expressApp';

/**
 * Catch-all serverless-функция для всех ОСТАЛЬНЫХ запросов на /api/*
 * (файл называется [...slug].ts — ловит любой путь под /api/, который не
 * попал под более специфичный именной файл).
 *
 * Cron-эндпоинты (/api/cron/sync, /api/cron/reprice, /api/cron/warm)
 * специально вынесены в ОТДЕЛЬНЫЕ файлы (api/cron/sync.ts и т.д.) —
 * у именных файлов в Vercel нет никакой неоднозначности с маршрутизацией
 * вложенных путей, в отличие от catch-all. Всё остальное (товары, заказы,
 * аналитика и т.д.) обрабатывает обычное Express-приложение.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    return app(req as any, res as any);
  } catch (err: any) {
    // Последний рубеж защиты: Express сам ловит ошибки внутри своих
    // роутов (см. errorHandler в expressApp.ts), но это на случай,
    // если что-то прорвётся мимо него.
    res.status(500).json({ error: 'Внутренняя ошибка сервера', details: String(err?.message ?? err) });
  }
}
