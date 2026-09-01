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
app.use(express.json());

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

// Дашборд (статика) — актуально только для локальной разработки, см. комментарий выше.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Обработчик ошибок
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Необработанная ошибка');
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

export default app;
