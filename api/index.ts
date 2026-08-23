import type { VercelRequest, VercelResponse } from '@vercel/node';
// Исходники в src/ не используют алиасы путей (все импорты — обычные
// относительные пути), поэтому Vercel не может неправильно их развернуть.
// Тем не менее здесь мы подключаем не "сырые" .ts из src/, а уже собранный
// JavaScript из dist/ — он создаётся во время сборки на Vercel командой
// "npm run build" (см. buildCommand в vercel.json), до того как Vercel
// начинает искать и собирать функции в api/, так что к моменту сборки
// этой функции dist/ уже гарантированно существует.
import app from '../dist/expressApp';
import { getKaspiStore, saveKaspiStore } from '../dist/handlers/kaspiStore';
import { getOzonStore, saveOzonStore } from '../dist/handlers/ozonStore';
import { getWbStore, saveWbStore } from '../dist/handlers/wbStore';

/**
 * ГЛАВНАЯ serverless-функция для всех запросов на /api/*, КРОМЕ тех, что
 * попадают под более специфичные выделенные файлы (api/cron/*.ts,
 * api/settings/kaspi-store.ts).
 *
 * ВАЖНО — почему файл называется index.ts, а не [...slug].ts:
 * файл с именем [...slug].ts — это "угадай-соглашение" Vercel по имени
 * файла для catch-all маршрутов. У нас были устойчивые проблемы именно с
 * МНОГОСЕГМЕНТНЫМИ путями через этот механизм (/sync/status, /sync/kaspi,
 * /settings/kaspi-store стабильно давали 404, хотя однос-сегментные пути
 * вроде /products работали). Поэтому вместо соглашения об имени файла
 * используется ЯВНЫЙ "rewrites" в vercel.json — это самый прямой,
 * официально документированный способ направить весь трафик /api/* в один
 * обработчик, без угадывания по имени файла.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const url = req.url || '';

    // /api/settings/kaspi-store продублирован и здесь на случай, если
    // выделенный файл api/settings/kaspi-store.ts почему-либо не
    // подхватится — три независимых пути гарантируют, что подключение
    // Kaspi-магазина сработает.
    if (url.startsWith('/api/settings/kaspi-store')) {
      if (req.method === 'GET') return res.status(200).json(await getKaspiStore());
      if (req.method === 'POST') {
        const result = await saveKaspiStore(req.body);
        return res.status(result.status).json(result.body);
      }
    }

    if (url.startsWith('/api/settings/ozon-store')) {
      if (req.method === 'GET') return res.status(200).json(await getOzonStore());
      if (req.method === 'POST') {
        const result = await saveOzonStore(req.body);
        return res.status(result.status).json(result.body);
      }
    }

    if (url.startsWith('/api/settings/wb-store')) {
      if (req.method === 'GET') return res.status(200).json(await getWbStore());
      if (req.method === 'POST') {
        const result = await saveWbStore(req.body);
        return res.status(result.status).json(result.body);
      }
    }

    return app(req as any, res as any);
  } catch (err: any) {
    // Последний рубеж защиты: Express сам ловит ошибки внутри своих
    // роутов (см. errorHandler в expressApp.ts), но это на случай,
    // если что-то прорвётся мимо него.
    res.status(500).json({ error: 'Внутренняя ошибка сервера', details: String(err?.message ?? err) });
  }
}
