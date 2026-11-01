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
import { ozonReturnsRouter } from './routes/ozonReturns.routes';
import { ozonFboRouter } from './routes/ozonFbo.routes';
import { repricerRouter } from './routes/repricer.routes';
import { priceFeedRouter } from './routes/priceFeed.routes';
import { reviewsRouter } from './routes/reviews.routes';
import { marginCalculatorRouter } from './routes/marginCalculator.routes';
import { settingsRouter } from './routes/settings.routes';
import { nichesRouter } from './routes/niches.routes';
import { searchAnalyticsRouter } from './routes/searchAnalytics.routes';
import { adsRouter } from './routes/ads.routes';
import { assistantRouter } from './routes/assistant.routes';
import { telegramAgentRouter } from './routes/telegramAgent.routes';
import { shopRouter } from './routes/shop.routes';
import { shopAdminRouter } from './routes/shopAdmin.routes';
import { shopMediaRouter } from './routes/shopMedia.routes';
import { showcasesRouter } from './routes/showcases.routes';
import { showcasesAdminRouter } from './routes/showcasesAdmin.routes';
import { cityImagesAdminRouter } from './routes/cityImages.routes';
import { yardRouter } from './routes/yard.routes';
import { categoriesRouter } from './routes/categories.routes';
import { yardAdminRouter } from './routes/yardAdmin.routes';
import { pushAdminRouter } from './routes/pushAdmin.routes';
import { wholesalersRouter } from './routes/wholesalers.routes';
import { adminAuthMiddleware } from './middleware/adminAuth';

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
// Защита административных API (Basic, ADMIN_USER / ADMIN_PASSWORD). Стоит ДО
// разбора тела запроса и ДО всех роутеров: закрыто всё под /api/, кроме явного
// списка публичных путей (/api/health, API приложения /api/shop/* с его
// x-app-key, фид Kaspi) — см. src/middleware/adminAuth.ts.
app.use(adminAuthMiddleware());
// ВАЖНО: лимит увеличен с дефолтного (~100кб) — иначе он падал раньше,
// чем доходило до роута загрузки медиа (см. shopMedia.routes.ts), даже
// раньше собственного лимита этого роута, потому что этот middleware
// глобальный и применяется первым. Vercel на своей стороне режет тело
// запроса примерно на 4.5 МБ независимо от наших настроек — 4мб здесь
// нужен, чтобы НАША ошибка (понятная, в JSON) сработала раньше, чем
// голый обрыв от инфраструктуры Vercel.
app.use(express.json({ limit: '4mb' }));
// Некорректный JSON в запросах к витринам — 400 с понятным текстом (общий обработчик
// ниже отвечает на такое 500; его поведение для остальных маршрутов не меняется).
app.use(['/api/shop-admin/showcases', '/api/shop/showcases'], (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Тело запроса не является корректным JSON', code: 'BAD_JSON' });
  }
  next(err);
});

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
  // /api/ozon-fbo и /api/ozon-returns ходят во внешний API Ozon (несколько страниц) —
  // как и синхронизации, им нужен длинный лимит, а не 8 секунд для запросов к базе.
  const isSyncRoute = req.url.startsWith('/api/sync/')
    || req.url.startsWith('/api/ozon-fbo')
    || req.url.startsWith('/api/ozon-returns')
    || req.url.startsWith('/api/shop/assistant')
    || req.url.startsWith('/api/telegram-agent')
    // Загрузка улиц города из OpenStreetMap — внешний запрос на 10–40 секунд.
    || req.url.startsWith('/api/shop-admin/streets/import');
  const timeoutMs = isSyncRoute ? 55000 : 8000;
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      logger.error(`⏱ ТАЙМАУТ: ${req.method} ${req.url} не ответил за ${timeoutMs / 1000} секунд`);
      res.status(504).json({
        error: `Таймаут запроса (>${timeoutMs / 1000}с)`,
        hint: isSyncRoute
          ? 'Запрос к площадке не успел завершиться за отведённое время. Попробуйте синхронизировать более короткий период (например, 7 дней вместо 30).'
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
app.use('/api/ozon-returns', ozonReturnsRouter);
app.use('/api/ozon-fbo', ozonFboRouter);
app.use('/api/repricer', repricerRouter);
app.use('/api/kaspi', priceFeedRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/margin-calculator', marginCalculatorRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/niches', nichesRouter);
app.use('/api/search-analytics', searchAnalyticsRouter);
app.use('/api/ads', adsRouter);
// ВАЖНО: /api/shop/admin ЗАРЕГИСТРИРОВАН РАНЬШЕ /api/shop — у /api/shop
// есть общий x-app-key middleware на весь путь (см. shop.routes.ts), а
// загрузка медиа — админский путь, ей x-app-key приложения не нужен и не
// должен быть нужен. Порядок здесь определяет, какой роут Express отдаст
// запрос первым, так что менять местами эти две строки нельзя.
app.use('/api/shop/admin', shopMediaRouter);
// Подбаннерные витрины: публичная часть (x-app-key, только чтение) и админская
// (вход Basic через adminAuthMiddleware). Оба — до общих роутеров, чтобы их
// пути не перехватывались чужими маршрутами с параметрами.
app.use('/api/shop/showcases', showcasesRouter);
app.use('/api/shop-admin/showcases', showcasesAdminRouter);
app.use('/api/shop-admin/city-images', cityImagesAdminRouter);
// Ассистент — до shopRouter (своя проверка x-app-key, длинный стрим).
app.use('/api/shop/assistant', assistantRouter);
app.use('/api/shop', shopRouter);
app.use('/api/shop-admin', shopAdminRouter);
// «Двор» — своя подсистема, свои таблицы, свои заказы, свои деньги. Не
// четвёртый маркетплейс и не полка My Market: x-app-key — собственная
// проверка внутри yardRouter, API-пути /api/shop/yard/..., админский
// раздел полностью отдельный от shopAdminRouter/shopRouter выше.
app.use('/api/shop', yardRouter);
app.use('/api/shop', categoriesRouter);
app.use('/api/yard-admin', yardAdminRouter);
app.use('/api/push-admin', pushAdminRouter);
// Telegram-бот для заведения товаров (вебхук публичный по секрету, /setup — админский).
app.use('/api/telegram-agent', telegramAgentRouter);
// Оптовики раздела «Товары» — полки по оптовикам, перенос товара, накладные (PDF/ZIP).
app.use('/api/wholesalers', wholesalersRouter);

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
