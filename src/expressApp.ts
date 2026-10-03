// test update 23.08
// update 23.08-2
import express from 'express';
import cors from 'cors';
import path from 'path';
import { logger } from './utils/logger';
import { productsRouter } from './routes/products.routes';
import { ordersRouter } from './routes/orders.routes';
import { analyticsRouter } from './routes/analytics.routes';
import { expensesRouter } from './routes/expenses.routes';
import { syncRouter } from './routes/sync.routes';
import { repricerRouter } from './routes/repricer.routes';
import { priceFeedRouter } from './routes/priceFeed.routes';
import { reviewsRouter } from './routes/reviews.routes';
import { marginCalculatorRouter } from './routes/marginCalculator.routes';
import { settingsRouter } from './routes/settings.routes';
import { nichesRouter } from './routes/niches.routes';
import { shopRouter } from './routes/shop.routes';
import { shopAdminRouter } from './routes/shopAdmin.routes';
import { shopMediaRouter } from './routes/shopMedia.routes';

/**
 * Собранное Express-приложение без вызова .listen(). Используется двумя
 * входными точками:
 *  - src/server.ts   — для локальной разработки (npm run dev)
 *  - api/[...slug].ts — serverless-функция на Vercel (в продакшене)
 *
 * Статика (public/) отдаётся отсюда только для локальной разработки —
 * на Vercel её раздаёт сам Vercel напрямую (см. "outputDirectory": "public"
 * в vercel.json), не доходя до этой функции, так быстрее и бесплатно.
 */
const app = express();

app.use(cors());
// ВАЖНО: лимит увеличен с дефолтного (~100кб) — иначе он падал раньше,
// чем доходило до роута загрузки медиа (см. shopMedia.routes.ts), даже
// раньше собственного лимита этого роута, потому что этот middleware
// глобальный и применяется первым. Vercel на своей стороне режет тело
// запроса примерно на 4.5 МБ независимо от наших настроек — 4мб здесь
// нужен, чтобы НАША ошибка (понятная, в JSON) сработала раньше, чем
// голый обрыв от инфраструктуры Vercel.
app.use(express.json({ limit: '4mb' }));

app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.url}`);
  next();
});

/**
 * Защитный таймер. Без него, если что-то зависает (например, не
 * устанавливается подключение к базе данных), запрос молча висит, пока
 * сама платформа Vercel не оборвёт его — а в логах это выглядит как
 * необъяснимая ошибка без причины (статус "---" вместо кода и текста).
 * С этим таймером сервер сам вернёт понятный ответ и запишет в лог, ЧТО
 * именно зависло — это не "чинит" саму медленную операцию, но даёт
 * настоящую диагностику вместо гадания.
 *
 * ВАЖНО: у разных запросов РАЗНЫЙ разумный лимит.
 * - Синхронизация с площадками (/api/sync/*) — это по своей природе
 *   долгая операция (десятки запросов к Kaspi API постранично, по
 *   нескольким статусам и кускам дат), и 8 секунд для неё физически
 *   мало. Даём почти весь бюджет времени функции на Vercel (maxDuration
 *   в vercel.json = 60с) — 55 секунд, с запасом.
 * - Всё остальное (товары, заказы из БД, аналитика и т.д.) — это простые
 *   запросы к базе, которые ДОЛЖНЫ отвечать быстро; для них оставляем
 *   тесный лимит в 8 секунд как раньше — это по-прежнему полезная
 *   диагностика зависшего подключения к базе.
 */
app.use((req, res, next) => {
  const isSyncRoute = req.url.startsWith('/api/sync/');
  const timeoutMs = isSyncRoute ? 55000 : 8000;
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      logger.error(`⏱ ТАЙМАУТ: ${req.method} ${req.url} не ответил за ${timeoutMs / 1000} секунд`);
      res.status(504).json({
        error: `Таймаут запроса (>${timeoutMs / 1000}с)`,
        hint: isSyncRoute
          ? 'Синхронизация не успела завершиться за отведённое время. Попробуйте синхронизировать более короткий период (например, 7 дней вместо 30).'
          : 'Вероятно, не удаётся подключиться к базе данных. Проверьте DATABASE_URL и статус проекта в Neon Dashboard.',
      });
    }
  }, timeoutMs);
  res.on('finish', () => clearTimeout(timer));
  next();
});

// buildMarker — вручную обновляемая метка версии кода. После деплоя
// открой https://твой-сайт.vercel.app/api/health в браузере: если там
// видно "kaspi-14day-date-chunking" — новый код точно на сервере. Если
// нет (или health вообще не отвечает) — деплой ещё не подхватил свежие
// файлы, и проблему нужно искать в самой загрузке на GitHub/Vercel, а не в коде.
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  buildMarker: 'kaspi-14day-date-chunking',
}));

app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/sync', syncRouter);
app.use('/api/repricer', repricerRouter);
app.use('/api/kaspi', priceFeedRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/margin-calculator', marginCalculatorRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/niches', nichesRouter);
// ВАЖНО: /api/shop/admin ЗАРЕГИСТРИРОВАН РАНЬШЕ /api/shop — у /api/shop
// есть общий x-app-key middleware на весь путь (см. shop.routes.ts), а
// загрузка медиа — админский путь, ей x-app-key приложения не нужен и не
// должен быть нужен. Порядок здесь определяет, какой роут Express отдаст
// запрос первым, так что менять местами эти две строки нельзя.
app.use('/api/shop/admin', shopMediaRouter);
app.use('/api/shop', shopRouter);
app.use('/api/shop-admin', shopAdminRouter);

// Дашборд (статика) — актуально только для локальной разработки, см. комментарий выше.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Обработчик ошибок — ВАЖНО: реальный текст ошибки должен быть виден в
// ответе (details), а не спрятан за общим "Внутренняя ошибка сервера".
// Раньше это маскировало настоящую причину (например, PayloadTooLargeError
// от слишком большого тела запроса) — теперь видно, что произошло на самом деле.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Необработанная ошибка');
  const isPayloadTooLarge = err?.type === 'entity.too.large' || err?.status === 413;
  res.status(isPayloadTooLarge ? 413 : 500).json({
    error: isPayloadTooLarge ? 'Файл слишком большой для тела запроса' : 'Внутренняя ошибка сервера',
    details: String(err?.message ?? err),
  });
});

export default app;
