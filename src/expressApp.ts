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
 * Защитный таймер на 8 секунд. Без него, если что-то зависает (например,
 * не устанавливается подключение к базе данных), запрос молча висит, пока
 * сама платформа Vercel не оборвёт его — а в логах это выглядит как
 * необъяснимая ошибка без причины (статус "---" вместо кода и текста).
 * С этим таймером сервер сам вернёт понятный ответ и запишет в лог, ЧТО
 * именно зависло — это не "чинит" саму медленную операцию, но даёт
 * настоящую диагностику вместо гадания.
 */
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      logger.error(`⏱ ТАЙМАУТ: ${req.method} ${req.url} не ответил за 8 секунд — вероятно, зависло подключение к базе данных`);
      res.status(504).json({
        error: 'Таймаут запроса (>8с)',
        hint: 'Вероятно, не удаётся подключиться к базе данных. Проверьте DATABASE_URL и статус проекта в Neon Dashboard.',
      });
    }
  }, 8000);
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
