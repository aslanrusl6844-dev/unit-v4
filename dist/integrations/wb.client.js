"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.wbClient = exports.WbClient = void 0;
exports.financeBySrid = financeBySrid;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const prisma_1 = require("../db/prisma");
/**
 * Клиент для Wildberries Statistics API + Content API.
 * Документация: https://dev.wildberries.ru/en/docs/openapi/reports
 *
 * Токен берётся ДИНАМИЧЕСКИ: сначала пробуем найти сохранённый магазин в
 * базе (форма в разделе «Настройки»), и только если его нет — используем
 * WB_API_TOKEN из переменных окружения (для обратной совместимости).
 *
 * Устроено иначе, чем у Kaspi/Ozon:
 * - Заказы отдаются построчно, 1 строка = 1 заказ = 1 товар (без вложенных
 *   позиций), уникальный идентификатор — поле "srid".
 * - У эндпоинта нет "dateTo" — только "dateFrom", а постранично нужно идти,
 *   подставляя "lastChangeDate" последней строки предыдущего ответа.
 * - Комиссию и логистику отдаёт ОТДЕЛЬНЫЙ отчёт о реализации
 *   (reportDetailByPeriod) — сопоставляем с заказами по тому же полю "srid".
 *   Свежие заказы могут ещё не попасть в этот отчёт (WB считает его не сразу) —
 *   тогда комиссия по ним временно будет нулевой, это нормально и подтянется
 *   при следующей синхронизации.
 */
const MAX_PAGES_SAFETY = 50; // защита от случайного бесконечного цикла пагинации
const MAX_429_RETRIES = 3;
const PACING_DELAY_MS = 350; // небольшая пауза между запросами подряд — снижает риск упереться в лимит вообще
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Обёртка вокруг любого запроса к WB API: при 429 (Too Many Requests)
 * читает заголовок X-Ratelimit-Retry (сколько секунд ждать — так советует
 * официальная документация WB), ждёт и повторяет запрос — до
 * MAX_429_RETRIES раз. Если лимит так и не снялся — кидает понятную
 * ошибку на русском, а не сырой "Request failed with status code 429".
 */
async function withRetryOn429(fn, context) {
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            if (err?.response?.status !== 429)
                throw err;
            if (attempt >= MAX_429_RETRIES) {
                logger_1.logger.error({ context }, '[Wildberries] 429 — попытки повтора исчерпаны');
                throw new Error('WB временно ограничил запросы, подождите минуту и попробуйте синхронизацию ещё раз.');
            }
            const headers = err.response?.headers ?? {};
            const retryHeader = headers['x-ratelimit-retry'] ?? headers['retry-after'];
            const waitSec = Number(retryHeader) > 0 ? Number(retryHeader) : 20; // разумный дефолт, если заголовка нет
            // WB иногда ставит паузу на час и больше (X-Ratelimit-Retry: 6454). Ждать столько функция не может —
            // раньше она «зависала» до таймаута, а журнал оставался «идёт». Сразу говорим, когда можно повторить.
            if (waitSec > 30) {
                const min = Math.ceil(waitSec / 60);
                logger_1.logger.warn({ context, waitSec }, '[Wildberries] 429 с долгой паузой — не ждём');
                throw new Error(`Wildberries временно ограничил запросы (${context}) — повторить можно примерно через ${min} мин. Это ограничение со стороны WB, ключ в порядке.`);
            }
            logger_1.logger.warn(`[Wildberries] 429 Too Many Requests (${context}) — жду ${waitSec}с, попытка ${attempt + 1}/${MAX_429_RETRIES}`);
            await sleep(waitSec * 1000);
        }
    }
    // Формально недостижимо (цикл либо возвращает, либо кидает выше), но нужно для типов.
    throw new Error('WB временно ограничил запросы, подождите минуту и попробуйте синхронизацию ещё раз.');
}
async function getWbToken() {
    const store = await prisma_1.prisma.wbStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (store?.apiToken)
        return store.apiToken;
    if (env_1.env.wb.apiToken)
        return env_1.env.wb.apiToken;
    return null;
}
const money = (v) => {
    const n = Number(String(v ?? '0').replace(',', '.'));
    return Number.isFinite(n) ? Math.abs(n) : 0;
};
/** Суммы комиссии/логистики/эквайринга по srid из строк детализации. */
function financeBySrid(rows) {
    const map = new Map();
    for (const row of rows) {
        if (!row.srid)
            continue;
        const entry = map.get(row.srid) ?? { commission: 0, logistics: 0, acquiring: 0 };
        entry.commission += money(row.ppvzSalesCommission);
        entry.logistics += money(row.deliveryService) + money(row.rebillLogisticCost);
        entry.acquiring += money(row.acquiringFee);
        map.set(row.srid, entry);
    }
    return map;
}
class WbClient {
    async isConfigured() {
        const token = await getWbToken();
        return Boolean(token);
    }
    async getHttp() {
        const token = await getWbToken();
        if (!token) {
            throw new Error('Wildberries API не настроен: добавьте магазин в разделе «Настройки» или задайте WB_API_TOKEN в .env');
        }
        return axios_1.default.create({
            baseURL: env_1.env.wb.statsBaseUrl,
            headers: { Authorization: token },
            timeout: 30000,
        });
    }
    // Отчёт реализации (комиссия, логистика, эквайринг) — с 2026 года на finance-api WB:
    // POST /api/finance/v1/sales-reports/detailed. Старый /api/v5/supplier/reportDetailByPeriod
    // WB отключил (отвечает 404). Токену нужна категория доступа «Финансы».
    async getFinanceHttp() {
        const token = await getWbToken();
        if (!token) {
            throw new Error('Wildberries API не настроен: добавьте магазин в разделе «Настройки» или задайте WB_API_TOKEN в .env');
        }
        return axios_1.default.create({
            baseURL: env_1.env.wb.financeBaseUrl,
            headers: { Authorization: token, 'Content-Type': 'application/json' },
            timeout: 30000,
        });
    }
    // Карточки товаров живут на ДРУГОМ хосте WB API (Content API, не
    // Statistics) — и токен для него должен быть с категорией доступа
    // "Контент". Если используется токен только со статистикой — этот
    // конкретный метод (fetchCatalog) вернёт ошибку авторизации, но
    // синхронизация заказов (fetchOrders) продолжит работать как обычно,
    // это не связанные между собой категории доступа.
    async getContentHttp() {
        const token = await getWbToken();
        if (!token) {
            throw new Error('Wildberries API не настроен: добавьте магазин в разделе «Настройки» или задайте WB_API_TOKEN в .env');
        }
        return axios_1.default.create({
            baseURL: env_1.env.wb.contentBaseUrl,
            headers: { Authorization: token },
            timeout: 30000,
        });
    }
    // Цены живут на ТРЕТЬЕМ хосте WB API (Prices/discounts, отдельно от
    // Statistics и Content) — токен должен иметь категорию доступа "Цены и
    // скидки". Официальная документация: https://openapi.wb.ru/prices/api/en/
    async getPricesHttp() {
        const token = await getWbToken();
        if (!token) {
            throw new Error('Wildberries API не настроен: добавьте магазин в разделе «Настройки» или задайте WB_API_TOKEN в .env');
        }
        return axios_1.default.create({
            baseURL: env_1.env.wb.pricesBaseUrl,
            headers: { Authorization: token },
            timeout: 30000,
        });
    }
    /**
     * Текущие цены товаров — GET /api/v2/list/goods/filter (без указания
     * артикула — отдаёт по ВСЕМ товарам сразу, так рекомендует официальная
     * документация). Подтверждённый формат ответа:
     *   { data: { listGoods: [ { nmID, vendorCode, sizes: [{ price, discountedPrice }], ... } ] } }
     * Берём discountedPrice — это реальная цена, которую платит покупатель
     * (с учётом скидки продавца), а не список price без скидки.
     */
    async fetchPrices() {
        const pricesHttp = await this.getPricesHttp();
        const result = new Map();
        // ВАЖНО (подтверждено официальной документацией dev.wildberries.ru):
        // "To get data for all products, do not set the article, set
        // limit=1000, and use the offset field to set the data offset." — без
        // этих параметров запрос, судя по всему, отвечает 200 OK с пустым
        // списком (без ошибки), из-за чего цены молча не подтягивались. Теперь
        // передаём limit явно и постранично идём через offset, пока не
        // получим страницу короче limit.
        const limit = 1000;
        let offset = 0;
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const response = await withRetryOn429(() => pricesHttp.get('/api/v2/list/goods/filter', { params: { limit, offset } }), 'цены товаров');
                // Терпимый разбор — пробуем несколько вероятных путей к списку, на
                // случай если структура чуть отличается от задокументированной.
                const goods = response.data?.data?.listGoods ?? response.data?.listGoods ?? [];
                if (goods.length === 0 && offset === 0) {
                    // Ничего не нашли даже на первой странице — логируем СЫРОЙ ответ
                    // целиком, чтобы при следующей проблеме сразу было видно точную
                    // структуру, а не гадать заново.
                    logger_1.logger.warn({ sampleResponse: response.data }, '[Wildberries] /api/v2/list/goods/filter вернул пустой список товаров — см. sampleResponse');
                }
                goods.forEach((item) => {
                    const size = item.sizes?.[0];
                    const price = size?.discountedPrice ?? size?.price;
                    if (item.nmID && price != null)
                        result.set(item.nmID, price);
                });
                if (goods.length < limit)
                    break; // последняя страница
                offset += limit;
                await sleep(PACING_DELAY_MS);
            }
        }
        catch (err) {
            if (err.message?.includes('WB временно ограничил'))
                throw err;
            const wbErrorBody = err?.response?.data;
            logger_1.logger.error({ status: err?.response?.status, body: wbErrorBody }, '[Wildberries] Ошибка запроса цен (/api/v2/list/goods/filter, проверьте категорию доступа токена "Цены и скидки")');
            throw new Error(`Wildberries API вернул ошибку ${err?.response?.status ?? ''} при запросе цен: ` +
                `${JSON.stringify(wbErrorBody) || err?.message}`);
        }
        logger_1.logger.info(`[Wildberries] Получено цен: ${result.size}`);
        return result;
    }
    /**
     * Полный каталог карточек товаров — POST /content/v2/get/cards/list,
     * с постраничной курсорной пагинацией (limit + cursor.updatedAt/nmID из
     * предыдущего ответа). У каждой карточки: nmID (номер WB), vendorCode
     * (= supplierArticle, наш wbArticle) и title (название).
     */
    async fetchCatalog() {
        const contentHttp = await this.getContentHttp();
        const catalog = [];
        let cursor = { limit: 100 };
        for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
            if (page > 0)
                await sleep(PACING_DELAY_MS); // пауза между страницами — снижает риск 429
            let data;
            try {
                const response = await withRetryOn429(() => contentHttp.post('/content/v2/get/cards/list', { settings: { cursor, filter: { withPhoto: -1 } } }), 'каталог карточек');
                data = response.data;
            }
            catch (err) {
                if (err.message?.includes('WB временно ограничил'))
                    throw err; // уже понятное сообщение, прокидываем как есть
                const wbErrorBody = err?.response?.data;
                logger_1.logger.error({ status: err?.response?.status, body: wbErrorBody }, '[Wildberries] Ошибка запроса карточек товаров (проверьте, что токен имеет категорию доступа "Контент")');
                throw new Error(`Wildberries API вернул ошибку ${err?.response?.status ?? ''} при запросе карточек товаров: ` +
                    `${JSON.stringify(wbErrorBody) || err?.message}`);
            }
            // "Предмет" WB (subjectName) — ключ для поиска комиссии в справочнике
            // (см. wb.categories.ts). Нужен именно ТЕКСТ предмета, как в таблице
            // тарифов, не subjectID (числовой внутренний идентификатор WB).
            // Точное имя поля в Content API документировано не так подробно, как
            // у Statistics API (где мы уже уверенно используем row.subject) —
            // пробуем несколько вероятных вариантов, а не полагаемся на одно имя.
            const cards = data.cards ?? [];
            cards.forEach((card) => {
                catalog.push({
                    vendorCode: card.vendorCode,
                    name: card.title?.trim() || `WB-товар ${card.vendorCode}`,
                    nmId: card.nmID,
                    subject: card.subjectName ?? card.subject ?? card.object,
                    // Фото карточки — только читаем из уже приходящего ответа
                    // (photos[]), в WB ничего не меняем. Берём самый крупный
                    // доступный размер, порядок как в карточке (первое = главное).
                    images: Array.from(new Set((card.photos ?? [])
                        .map((ph) => ph.big ?? ph.hq ?? ph.c516x688 ?? ph.c246x328 ?? ph.square ?? ph.tm)
                        .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))).slice(0, 10),
                });
            });
            const total = data.cursor?.total ?? 0;
            // ВАЖНО: 0 — легитимное значение nmID (а не "данных нет"), поэтому
            // проверяем именно на undefined/null, а не через простое отрицание
            // (!0 === true в JS сломало бы пагинацию на ровном месте).
            if (total < cursor.limit || data.cursor?.nmID == null)
                break;
            cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
        }
        logger_1.logger.info(`[Wildberries] В каталоге карточек товаров: ${catalog.length}`);
        return catalog;
    }
    async fetchOrders(params) {
        const http = await this.getHttp();
        const rows = await this.fetchOrderRows(http, params.dateFrom);
        // Финансы — отдельный сервис WB. Если он не ответил (нет категории «Финансы» у токена,
        // лимит 1 запрос/мин и т. п.) — заказы всё равно сохраняем, только без комиссии из отчёта.
        let financeMap = new Map();
        try {
            financeMap = await this.fetchFinanceBySrid(params.dateFrom, params.dateTo);
        }
        catch (err) {
            const status = err?.response?.status;
            logger_1.logger.warn({ status, message: String(err?.message ?? err).slice(0, 200) }, status === 401 || status === 403
                ? '[Wildberries] Отчёт реализации: у токена нет доступа к категории «Финансы» — заказы без комиссии из отчёта'
                : '[Wildberries] Отчёт реализации недоступен — заказы сохраняем без комиссии из отчёта');
        }
        const filtered = rows.filter((r) => {
            const d = new Date(r.date);
            return d >= params.dateFrom && d <= params.dateTo;
        });
        const orders = filtered.map((row) => this.toNormalizedOrder(row, financeMap.get(row.srid)));
        logger_1.logger.info(`[Wildberries] Загружено заказов: ${orders.length}`);
        return orders;
    }
    /** Постранично тянет /api/v1/supplier/orders, используя lastChangeDate для пагинации. */
    async fetchOrderRows(http, dateFrom) {
        const all = [];
        let cursor = dateFrom.toISOString();
        for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
            if (page > 0)
                await sleep(PACING_DELAY_MS);
            const { data } = await withRetryOn429(() => http.get('/api/v1/supplier/orders', { params: { dateFrom: cursor, flag: 0 } }), 'список заказов');
            if (!data?.length)
                break;
            all.push(...data);
            const lastRow = data[data.length - 1];
            if (!lastRow?.lastChangeDate || lastRow.lastChangeDate === cursor)
                break;
            cursor = lastRow.lastChangeDate;
            if (data.length < 1000)
                break; // страница явно неполная — дальше пусто
        }
        return all;
    }
    /**
     * Комиссия/логистика/эквайринг по каждому srid из детализации отчётов реализации (новый метод WB).
     * Лимит WB — 1 запрос в минуту, поэтому берём одну страницу (до 100 000 строк — с запасом для 2–30 дней).
     */
    async fetchFinanceBySrid(dateFrom, dateTo) {
        const http = await this.getFinanceHttp();
        const res = await http.post('/api/finance/v1/sales-reports/detailed', {
            dateFrom: dateFrom.toISOString().slice(0, 10),
            dateTo: dateTo.toISOString().slice(0, 10),
            limit: 100000,
            rrdId: 0,
            period: 'daily',
            fields: ['rrdId', 'srid', 'ppvzSalesCommission', 'deliveryService', 'rebillLogisticCost', 'acquiringFee'],
        });
        if (res.status === 204 || !Array.isArray(res.data))
            return new Map();
        return financeBySrid(res.data);
    }
    toNormalizedOrder(row, finance) {
        const price = row.priceWithDisc ?? row.finishedPrice ?? row.totalPrice ?? 0;
        // Схема продажи — WB не отдаёт её отдельным явным полем, определяем по
        // типу склада: если склад принадлежит самому WB — это FBW (продажа со
        // склада WB), иначе — FBS (продажа со своего склада). Эвристика, а не
        // официально документированное поле — помечено как предположение в UI.
        const wbScheme = /wb|wildberries|склад wb/i.test(row.warehouseType || row.warehouseName || '') ? 'FBW' : 'FBS';
        const items = [
            {
                externalSku: row.supplierArticle || String(row.nmId),
                name: row.subject || row.supplierArticle || `Товар WB ${row.nmId}`,
                quantity: 1,
                price,
                wbSubject: row.subject,
                wbScheme,
            },
        ];
        return {
            externalId: row.srid,
            marketplace: 'WB',
            status: row.isCancel ? 'CANCELLED' : 'NEW',
            orderDate: new Date(row.date),
            deliveryType: row.warehouseType || row.warehouseName,
            city: row.regionName,
            totalRevenue: price,
            marketplaceCommission: finance?.commission ?? 0,
            logisticsCost: finance?.logistics ?? 0,
            acquiringCost: finance?.acquiring ?? 0,
            otherFees: 0,
            items,
            raw: row,
        };
    }
}
exports.WbClient = WbClient;
exports.wbClient = new WbClient();
//# sourceMappingURL=wb.client.js.map