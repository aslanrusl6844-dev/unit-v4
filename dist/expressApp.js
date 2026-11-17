"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// test update 23.08
// update 23.08-2
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("./utils/logger");
const products_routes_1 = require("./routes/products.routes");
const orders_routes_1 = require("./routes/orders.routes");
const analytics_routes_1 = require("./routes/analytics.routes");
const expenses_routes_1 = require("./routes/expenses.routes");
const sync_routes_1 = require("./routes/sync.routes");
const ozonReturns_routes_1 = require("./routes/ozonReturns.routes");
const ozonFbo_routes_1 = require("./routes/ozonFbo.routes");
const repricer_routes_1 = require("./routes/repricer.routes");
const priceFeed_routes_1 = require("./routes/priceFeed.routes");
const reviews_routes_1 = require("./routes/reviews.routes");
const marginCalculator_routes_1 = require("./routes/marginCalculator.routes");
const settings_routes_1 = require("./routes/settings.routes");
const niches_routes_1 = require("./routes/niches.routes");
const searchAnalytics_routes_1 = require("./routes/searchAnalytics.routes");
const ads_routes_1 = require("./routes/ads.routes");
const assistant_routes_1 = require("./routes/assistant.routes");
const creator_routes_1 = require("./routes/creator.routes");
const live_routes_1 = require("./routes/live.routes");
const telegramAgent_routes_1 = require("./routes/telegramAgent.routes");
const ozonBot_routes_1 = require("./routes/ozonBot.routes");
const shop_routes_1 = require("./routes/shop.routes");
const shopAdmin_routes_1 = require("./routes/shopAdmin.routes");
const shopMedia_routes_1 = require("./routes/shopMedia.routes");
const showcases_routes_1 = require("./routes/showcases.routes");
const showcasesAdmin_routes_1 = require("./routes/showcasesAdmin.routes");
const cityImages_routes_1 = require("./routes/cityImages.routes");
const yard_routes_1 = require("./routes/yard.routes");
const categories_routes_1 = require("./routes/categories.routes");
const yardAdmin_routes_1 = require("./routes/yardAdmin.routes");
const pushAdmin_routes_1 = require("./routes/pushAdmin.routes");
const wholesalers_routes_1 = require("./routes/wholesalers.routes");
const adminAuth_1 = require("./middleware/adminAuth");
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
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
// Защита административных API (Basic, ADMIN_USER / ADMIN_PASSWORD). Стоит ДО
// разбора тела запроса и ДО всех роутеров: закрыто всё под /api/, кроме явного
// списка публичных путей (/api/health, API приложения /api/shop/* с его
// x-app-key, фид Kaspi) — см. src/middleware/adminAuth.ts.
app.use((0, adminAuth_1.adminAuthMiddleware)());
// ВАЖНО: лимит увеличен с дефолтного (~100кб) — иначе он падал раньше,
// чем доходило до роута загрузки медиа (см. shopMedia.routes.ts), даже
// раньше собственного лимита этого роута, потому что этот middleware
// глобальный и применяется первым. Vercel на своей стороне режет тело
// запроса примерно на 4.5 МБ независимо от наших настроек — 4мб здесь
// нужен, чтобы НАША ошибка (понятная, в JSON) сработала раньше, чем
// голый обрыв от инфраструктуры Vercel.
app.use(express_1.default.json({ limit: '4mb' }));
// Некорректный JSON в запросах к витринам — 400 с понятным текстом (общий обработчик
// ниже отвечает на такое 500; его поведение для остальных маршрутов не меняется).
app.use(['/api/shop-admin/showcases', '/api/shop/showcases'], (err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Тело запроса не является корректным JSON', code: 'BAD_JSON' });
    }
    next(err);
});
app.use((req, _res, next) => {
    logger_1.logger.debug(`${req.method} ${req.url}`);
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
        || req.url.startsWith('/api/ozon-bot')
        // Загрузка улиц города из OpenStreetMap — внешний запрос на 10–40 секунд.
        || req.url.startsWith('/api/shop-admin/streets/import');
    const timeoutMs = isSyncRoute ? 55000 : 8000;
    const timer = setTimeout(() => {
        if (!res.headersSent) {
            logger_1.logger.error(`⏱ ТАЙМАУТ: ${req.method} ${req.url} не ответил за ${timeoutMs / 1000} секунд`);
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
// Режим сервера: у копии для другого продавца (только Kaspi и Ozon, без My Market) задаются
//   APP_MODE=marketplaces и ENABLED_MARKETPLACES=KASPI,OZON — админка прячет лишние разделы.
app.get('/api/app-config', (_req, res) => {
    const all = ['KASPI', 'OZON', 'WB', 'TEEZ'];
    const enabled = (process.env.ENABLED_MARKETPLACES || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => all.includes(x));
    res.json({ marketplaces: enabled.length ? enabled : all, shop: process.env.APP_MODE !== 'marketplaces' });
});
app.use('/api/products', products_routes_1.productsRouter);
app.use('/api/orders', orders_routes_1.ordersRouter);
app.use('/api/analytics', analytics_routes_1.analyticsRouter);
app.use('/api/expenses', expenses_routes_1.expensesRouter);
app.use('/api/sync', sync_routes_1.syncRouter);
app.use('/api/ozon-returns', ozonReturns_routes_1.ozonReturnsRouter);
app.use('/api/ozon-fbo', ozonFbo_routes_1.ozonFboRouter);
app.use('/api/repricer', repricer_routes_1.repricerRouter);
app.use('/api/kaspi', priceFeed_routes_1.priceFeedRouter);
app.use('/api/reviews', reviews_routes_1.reviewsRouter);
app.use('/api/margin-calculator', marginCalculator_routes_1.marginCalculatorRouter);
app.use('/api/settings', settings_routes_1.settingsRouter);
app.use('/api/niches', niches_routes_1.nichesRouter);
app.use('/api/search-analytics', searchAnalytics_routes_1.searchAnalyticsRouter);
app.use('/api/ads', ads_routes_1.adsRouter);
// ВАЖНО: /api/shop/admin ЗАРЕГИСТРИРОВАН РАНЬШЕ /api/shop — у /api/shop
// есть общий x-app-key middleware на весь путь (см. shop.routes.ts), а
// загрузка медиа — админский путь, ей x-app-key приложения не нужен и не
// должен быть нужен. Порядок здесь определяет, какой роут Express отдаст
// запрос первым, так что менять местами эти две строки нельзя.
app.use('/api/shop/admin', shopMedia_routes_1.shopMediaRouter);
// Подбаннерные витрины: публичная часть (x-app-key, только чтение) и админская
// (вход Basic через adminAuthMiddleware). Оба — до общих роутеров, чтобы их
// пути не перехватывались чужими маршрутами с параметрами.
app.use('/api/shop/showcases', showcases_routes_1.showcasesRouter);
app.use('/api/shop-admin/showcases', showcasesAdmin_routes_1.showcasesAdminRouter);
app.use('/api/shop-admin/city-images', cityImages_routes_1.cityImagesAdminRouter);
// Ассистент — до shopRouter (своя проверка x-app-key, длинный стрим).
app.use('/api/shop/assistant', assistant_routes_1.assistantRouter);
// Креаторы My Market Live — до shopRouter (своя проверка x-app-key).
app.use('/api/shop/creator', creator_routes_1.creatorRouter);
app.use('/api/shop-admin/creators', creator_routes_1.creatorAdminRouter);
app.use('/api/shop/live', live_routes_1.liveRouter);
app.use('/api/shop-admin/live', live_routes_1.liveAdminRouter);
app.use('/api/shop', shop_routes_1.shopRouter);
app.use('/api/shop-admin', shopAdmin_routes_1.shopAdminRouter);
// «Двор» — своя подсистема, свои таблицы, свои заказы, свои деньги. Не
// четвёртый маркетплейс и не полка My Market: x-app-key — собственная
// проверка внутри yardRouter, API-пути /api/shop/yard/..., админский
// раздел полностью отдельный от shopAdminRouter/shopRouter выше.
app.use('/api/shop', yard_routes_1.yardRouter);
app.use('/api/shop', categories_routes_1.categoriesRouter);
app.use('/api/yard-admin', yardAdmin_routes_1.yardAdminRouter);
app.use('/api/push-admin', pushAdmin_routes_1.pushAdminRouter);
// Telegram-бот для заведения товаров (вебхук публичный по секрету, /setup — админский).
app.use('/api/telegram-agent', telegramAgent_routes_1.telegramAgentRouter);
app.use('/api/ozon-bot', ozonBot_routes_1.ozonBotRouter);
// Оптовики раздела «Товары» — полки по оптовикам, перенос товара, накладные (PDF/ZIP).
app.use('/api/wholesalers', wholesalers_routes_1.wholesalersRouter);
// Дашборд (статика) — актуально только для локальной разработки, см. комментарий выше.
app.use(express_1.default.static(path_1.default.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api'))
        return next();
    res.sendFile(path_1.default.join(__dirname, '..', 'public', 'index.html'));
});
// Обработчик ошибок — ВАЖНО: реальный текст ошибки должен быть виден в
// ответе (details), а не спрятан за общим "Внутренняя ошибка сервера".
// Раньше это маскировало настоящую причину (например, PayloadTooLargeError
// от слишком большого тела запроса) — теперь видно, что произошло на самом деле.
app.use((err, _req, res, _next) => {
    logger_1.logger.error({ err }, 'Необработанная ошибка');
    const isPayloadTooLarge = err?.type === 'entity.too.large' || err?.status === 413;
    res.status(isPayloadTooLarge ? 413 : 500).json({
        error: isPayloadTooLarge ? 'Файл слишком большой для тела запроса' : 'Внутренняя ошибка сервера',
        details: String(err?.message ?? err),
    });
});
exports.default = app;
//# sourceMappingURL=expressApp.js.map