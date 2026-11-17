"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.kaspiClient = exports.KaspiClient = void 0;
exports.getKaspiCredentials = getKaspiCredentials;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const prisma_1 = require("../db/prisma");
async function getKaspiCredentials() {
    const store = await prisma_1.prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (store?.apiToken) {
        return { token: store.apiToken, baseUrl: env_1.env.kaspi.baseUrl, merchantUid: store.merchantUid ?? env_1.env.kaspi.merchantUid };
    }
    if (env_1.env.kaspi.token) {
        return { token: env_1.env.kaspi.token, baseUrl: env_1.env.kaspi.baseUrl, merchantUid: env_1.env.kaspi.merchantUid };
    }
    return null;
}
class KaspiClient {
    /** true/false — есть ли вообще откуда взять токен (БД или .env). */
    async isConfigured() {
        const creds = await getKaspiCredentials();
        return Boolean(creds?.token);
    }
    async getHttp() {
        const creds = await getKaspiCredentials();
        if (!creds) {
            throw new Error('Kaspi API не настроен: добавьте магазин в разделе «Настройки» или задайте KASPI_API_TOKEN в .env');
        }
        // Явная проверка вместо того, чтобы дать axios упасть с непонятным
        // "Invalid URL" — если базовый адрес API вдруг оказался пустым или
        // не похож на настоящий URL, сразу говорим прямо, в чём дело.
        if (!creds.baseUrl || !/^https?:\/\//.test(creds.baseUrl)) {
            throw new Error(`Некорректный базовый адрес Kaspi API: "${creds.baseUrl}". Проверьте KASPI_API_BASE_URL в Environment Variables ` +
                `(должен быть похож на https://kaspi.kz/shop/api/v2) или просто удалите эту переменную, чтобы использовалось значение по умолчанию.`);
        }
        return axios_1.default.create({
            baseURL: creds.baseUrl,
            headers: {
                'X-Auth-Token': creds.token,
                'Content-Type': 'application/vnd.api+json',
            },
            timeout: 20000,
        });
    }
    /**
     * Разбивает период на куски не длиннее maxDays — у Kaspi есть жёсткое
     * ограничение на диапазон filter[orders][creationDate] (точное сообщение
     * от их API: "Exceeded the maximum difference for the filter[orders]
     * [creationDate] (in days). Actual [30], max [14]."). Если запросить
     * сразу 30 или 90 дней, Kaspi вернёт 400 — поэтому режем на куски по
     * 14 дней и опрашиваем каждый кусок отдельно.
     */
    static chunkDateRange(dateFrom, dateTo, maxDays = 14) {
        const chunks = [];
        const maxMs = maxDays * 24 * 60 * 60 * 1000;
        let chunkStart = dateFrom.getTime();
        const endMs = dateTo.getTime();
        while (chunkStart < endMs) {
            const chunkEnd = Math.min(chunkStart + maxMs, endMs);
            chunks.push({ from: new Date(chunkStart), to: new Date(chunkEnd) });
            chunkStart = chunkEnd;
        }
        if (chunks.length === 0)
            chunks.push({ from: dateFrom, to: dateTo });
        return chunks;
    }
    /**
     * Получить список заказов за период. Kaspi отдаёт данные постранично
     * (page[number], page[size]) в формате JSON:API.
     *
     * Два важных ограничения API Kaspi, с которыми пришлось считаться:
     * 1. filter[orders][state] ОБЯЗАТЕЛЕН — единого "покажи заказы любого
     *    статуса" нет, поэтому опрашиваем ПО ОЧЕРЕДИ каждое известное
     *    состояние (включая COMPLETED/ARCHIVE — реальные завершённые продажи,
     *    которые и нужны для юнit-экономики, а не только новые NEW-заказы).
     * 2. Диапазон creationDate не может быть больше 14 дней за один запрос —
     *    поэтому весь период режется на куски по 14 дней (chunkDateRange) и
     *    результаты по всем кускам объединяются.
     */
    async fetchOrders(params) {
        const http = await this.getHttp();
        const pageSize = params.pageSize ?? 20; // как в официальном примере Kaspi Гид
        const seenIds = new Set();
        // Общий на весь запуск кэш названий товаров — см. комментарий в fetchOrderEntries.
        const productCache = new Map();
        // ВАЖНО: у Kaspi "state" и "status" — два РАЗНЫХ поля заказа, не
        // взаимозаменяемые (проверено по стороннему, но полному описанию
        // Kaspi Merchant API — github.com/abdymazhit/kaspi-merchant-api):
        //
        //   filter[orders][state]  — ОБЯЗАТЕЛЬНЫЙ фильтр, ровно 6 значений:
        //     NEW, SIGN_REQUIRED, PICKUP, DELIVERY, KASPI_DELIVERY, ARCHIVE
        //     (это "фаза" заказа: новый -> требует подписи -> самовывоз/доставка
        //     -> архив после завершения цикла, независимо от исхода).
        //
        //   filter[orders][status] — НЕобязательный фильтр, другие значения:
        //     APPROVED_BY_BANK, ACCEPTED_BY_MERCHANT, COMPLETED, CANCELLED,
        //     CANCELLING, KASPI_DELIVERY_RETURN_REQUESTED,
        //     RETURN_ACCEPTED_BY_MERCHANT, RETURNED — это его "исход/статус
        //     обработки" внутри фазы. Раньше мы ошибочно передавали эти
        //     значения КАК state — Kaspi возвращал 400 "does not match".
        //
        // Мы используем ТОЛЬКО filter[orders][state] (он обязателен), перебирая
        // все 6 допустимых значений — раз "status" необязателен, запрос по
        // каждому state уже возвращает заказы С ЛЮБЫМ статусом внутри этой фазы,
        // включая настоящие завершённые продажи (ARCHIVE — куда попадают все
        // заказы после окончания цикла, вне зависимости от того, чем он
        // закончился: доставлен, отменён или возвращён).
        const STATES = ['NEW', 'SIGN_REQUIRED', 'PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'];
        const dateChunks = KaspiClient.chunkDateRange(params.dateFrom, params.dateTo, 14);
        logger_1.logger.info(`[Kaspi] Период разбит на ${dateChunks.length} кусков (максимум 14 дней каждый)`);
        // ВАЖНО для скорости: на serverless (Vercel) есть жёсткий лимит времени
        // выполнения — а раньше все комбинации state×chunk опрашивались СТРОГО
        // ПО ОЧЕРЕДИ, из-за чего 30-дневная синхронизация (6 статусов × 3 куска
        // дат = 18 запросов, плюс ещё по одному запросу состава на каждый заказ)
        // легко не укладывалась в отведённое время. Теперь все комбинации
        // state×chunk запрашиваются ОДНОВРЕМЕННО (Promise.all) — это не уменьшает
        // число запросов к Kaspi, но резко сокращает время ожидания по часам,
        // потому что запросы идут параллельно, а не друг за другом.
        const tasks = [];
        for (const state of STATES) {
            for (const chunk of dateChunks) {
                tasks.push(this.fetchOrdersForStateAndChunk(http, state, chunk, pageSize, seenIds, productCache));
            }
        }
        const results = await Promise.all(tasks);
        const allOrders = results.flat();
        logger_1.logger.info(`[Kaspi] Загружено заказов: ${allOrders.length}`);
        return allOrders;
    }
    /** Один state + один кусок дат — со своей постраничной пагинацией внутри. */
    async fetchOrdersForStateAndChunk(http, state, chunk, pageSize, seenIds, productCache) {
        const orders = [];
        let pageNumber = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let data;
            try {
                const response = await http.get('/orders', {
                    params: {
                        'page[number]': pageNumber,
                        'page[size]': pageSize,
                        'filter[orders][state]': state,
                        'filter[orders][creationDate][$ge]': chunk.from.getTime(),
                        'filter[orders][creationDate][$le]': chunk.to.getTime(),
                    },
                });
                data = response.data;
            }
            catch (err) {
                // Логируем ТОЧНОЕ тело ответа Kaspi при ошибке — только по коду
                // статуса (400/401/403) не понять, что конкретно не устроило API,
                // а тело ответа обычно содержит понятное описание причины.
                const kaspiErrorBody = err?.response?.data;
                logger_1.logger.error({ status: err?.response?.status, body: kaspiErrorBody, state, chunk, pageNumber }, '[Kaspi] Ошибка запроса заказов');
                throw new Error(`Kaspi API вернул ошибку ${err?.response?.status ?? ''} при запросе заказов (state=${state}, ` +
                    `${chunk.from.toISOString().slice(0, 10)}..${chunk.to.toISOString().slice(0, 10)}): ` +
                    `${JSON.stringify(kaspiErrorBody) || err?.message || err}`);
            }
            if (!data.data?.length)
                break;
            // Состав каждого заказа тоже запрашиваем ПАРАЛЛЕЛЬНО (а не по очереди) —
            // это второй по значимости источник задержки при большом числе заказов.
            const newResources = data.data.filter((resource) => {
                if (seenIds.has(resource.id))
                    return false; // на всякий случай, вдруг заказ попал в выборку дважды
                seenIds.add(resource.id);
                return true;
            });
            const itemsPerOrder = await Promise.all(newResources.map((resource) => this.fetchOrderEntries(http, resource.id, productCache)));
            newResources.forEach((resource, i) => {
                orders.push(this.toNormalizedOrder(resource, itemsPerOrder[i]));
            });
            const totalPages = data.meta?.pageCount ?? 1;
            pageNumber += 1;
            if (pageNumber >= totalPages)
                break;
        }
        return orders;
    }
    /**
     * Получить состав заказа (товарные позиции) по id заказа.
     *
     * ВАЖНО: обычный include=product на списке позиций НЕ отдаёт название
     * товара (проверено — атрибуты entries содержат только количество/цену,
     * без имени). Название нужно запрашивать ОТДЕЛЬНО, по ссылке из
     * relationships.product (стандартный JSON:API related-link) — либо, если
     * её нет в ответе, напрямую через /orderentries/{entryId}/product.
     *
     * productCache — общий на весь запуск синхронизации кэш "id товара Kaspi
     * -> {name, code}", чтобы не запрашивать название повторно для одного и
     * того же товара в разных заказах (у активного магазина одни и те же
     * товары покупают многократно — кэш ощутимо сокращает число запросов).
     */
    async fetchOrderEntries(http, orderId, productCache) {
        try {
            const { data } = await http.get(`/orders/${orderId}/entries`);
            const resources = data.data ?? [];
            return await Promise.all(resources.map(async (entry) => {
                const relationships = entry.relationships ?? {};
                const productId = relationships.product?.data?.id;
                const relatedLink = relationships.product?.links?.related;
                const [productInfoResolved, entryDetail] = await Promise.all([
                    (async () => {
                        let productInfo = productId ? productCache.get(productId) : undefined;
                        if (!productInfo) {
                            productInfo = await this.fetchEntryProduct(http, entry.id, relatedLink);
                            if (productId && productInfo)
                                productCache.set(productId, productInfo);
                        }
                        return productInfo;
                    })(),
                    this.fetchEntryDetail(http, entry.id),
                ]);
                // ВАЖНО: раньше здесь запасным вариантом был entry.id — но это id
                // ПОЗИЦИИ КОНКРЕТНОГО ЗАКАЗА, разный при каждой продаже одного и
                // того же товара. Если запрос за кодом товара не удавался (сетевой
                // сбой, временная недоступность), один и тот же реальный товар
                // создавался заново под новым "SKU" при каждой такой неудаче — это
                // и есть причина дублей и путаницы со статусом "Активен". Теперь
                // запасной вариант — productId (id ТОВАРА в Kaspi, стабильный и
                // одинаковый для всех заказов этого товара), и только если его
                // тоже нет — entry.id как самый последний резерв.
                const merchantSku = productInfoResolved?.code || productId || entry.id;
                // Если название так и не удалось получить — оставляем пустую
                // строку здесь; понятное "запасное" имя (не одинаковое для всех)
                // формируется на уровне src/services/sync.service.ts, где уже
                // известен и SKU/артикул для подстановки в название.
                const name = productInfoResolved?.name?.trim() || '';
                return {
                    externalSku: String(merchantSku),
                    name,
                    quantity: entry.attributes.quantity ?? 1,
                    price: entry.attributes.quantity > 0
                        ? entry.attributes.totalPrice / entry.attributes.quantity
                        : entry.attributes.totalPrice,
                    // Категория и вес — прямо из Kaspi, если API их прислал (см.
                    // fetchEntryDetail). Категория здесь — LEAF-уровень (например,
                    // "Зонты"), не совпадает по формату с нашей таблицей ставок по
                    // ВЕРХНИМ категориям — сохраняем как kaspiLeafCategory, точную
                    // ставку по ней можно посчитать напрямую (см. LEAF_OVERRIDES в
                    // kaspi.categories.ts), либо используется безопасный дефолт.
                    kaspiLeafCategory: entryDetail?.category?.title,
                    weightG: entryDetail?.weight,
                };
            }));
        }
        catch (err) {
            logger_1.logger.warn({ status: err?.response?.status, body: err?.response?.data, orderId }, '[Kaspi] Не удалось получить состав заказа');
            return [];
        }
    }
    /**
     * Полная детализация ОДНОЙ позиции заказа — GET /orderentries/{entryId}
     * (не список, а именно один элемент). Только тут Kaspi отдаёт category
     * ({code, title}) и вес — списочный метод /orders/{id}/entries их не
     * содержит. Официально задокументировано в Kaspi Гид (q3204).
     */
    async fetchEntryDetail(http, entryId) {
        try {
            const { data } = await http.get(`/orderentries/${entryId}`);
            const attrs = data?.data?.attributes;
            if (!attrs)
                return undefined;
            return { category: attrs.category, weight: attrs.weight };
        }
        catch (err) {
            logger_1.logger.warn({ status: err?.response?.status, entryId }, '[Kaspi] Не удалось получить категорию/вес позиции заказа');
            return undefined;
        }
    }
    /** Название и код товара по id позиции заказа — отдельный запрос, см. комментарий выше. */
    async fetchEntryProduct(http, entryId, relatedLink) {
        try {
            // Если сервер сам прислал ссылку в relationships.product.links.related —
            // используем её (это абсолютный URL, axios справится с ним даже при
            // настроенном baseURL). Иначе — собираем путь по образцу официального
            // метода Kaspi API "получить товар по id позиции заказа".
            const { data } = relatedLink
                ? await http.get(relatedLink)
                : await http.get(`/orderentries/${entryId}/product`);
            const attrs = data?.data?.attributes;
            if (!attrs)
                return undefined;
            return { name: attrs.name ?? '', code: attrs.code ?? '' };
        }
        catch (err) {
            logger_1.logger.warn({ status: err?.response?.status, entryId }, '[Kaspi] Не удалось получить название товара по позиции заказа');
            return undefined;
        }
    }
    toNormalizedOrder(resource, items) {
        const attrs = resource.attributes;
        // Kaspi не отдаёт комиссию и логистику напрямую в заказе — они
        // рассчитываются в sync.service.ts на основе официальной таблицы
        // комиссий (src/integrations/kaspi.categories.ts) и тарифов доставки
        // (src/integrations/kaspi.delivery.ts), используя категорию/вес товара
        // из карточки Product. Здесь оставляем 0 — это лишь заготовка, которую
        // sync.service дополнит после сопоставления товарных позиций.
        const marketplaceCommission = 0;
        const logisticsCost = 0;
        const acquiringCost = 0;
        return {
            externalId: attrs.code,
            marketplace: 'KASPI',
            // Наш внутренний статус (используется для фильтров на странице
            // «Заказы» — Предзаказ/Упаковка/Передача/Переданы на доставку/
            // Отменены) ожидает значения вида APPROVED_BY_BANK/ACCEPTED_BY_MERCHANT/
            // COMPLETED/CANCELLED — это поле "status" у Kaspi, более информативное,
            // чем "state" (у которого всего 6 общих фаз). Используем status в
            // приоритете, state — только как запасной вариант для совсем новых
            // заказов, у которых status ещё не назначен.
            status: attrs.status ?? attrs.state,
            orderDate: new Date(attrs.creationDate),
            deliveryType: attrs.deliveryMode,
            city: attrs.city?.name,
            totalRevenue: attrs.totalPrice ?? items.reduce((s, i) => s + i.price * i.quantity, 0),
            marketplaceCommission,
            logisticsCost,
            acquiringCost,
            otherFees: 0,
            items,
            raw: resource,
            kaspiDelivery: attrs.kaspiDelivery,
            kaspiInternalId: resource.id,
        };
    }
    /**
     * Принять новый заказ (перевести в статус ACCEPTED_BY_MERCHANT).
     * См. Kaspi Гид: "Как принять новый заказ?"
     */
    async acceptOrder(kaspiInternalId, code) {
        const http = await this.getHttp();
        await http.post('/orders', {
            data: {
                type: 'orders',
                id: kaspiInternalId,
                attributes: { code, status: 'ACCEPTED_BY_MERCHANT' },
            },
        });
    }
    /**
     * Сформировать накладную для передачи заказа на Kaspi Доставку —
     * технически это перевод заказа в статус ASSEMBLE с указанием количества
     * мест (коробок/упаковок). После этого печатную накладную можно скачать
     * в личном кабинете Kaspi — API не отдаёт готовый PDF, только меняет статус.
     * См. Kaspi Гид: "Как сформировать накладную для передачи заказа на Kaspi Доставку?"
     */
    async formWaybill(kaspiInternalId, numberOfSpace) {
        const http = await this.getHttp();
        await http.post('/orders', {
            data: {
                type: 'orders',
                id: kaspiInternalId,
                attributes: { status: 'ASSEMBLE', numberOfSpace: String(numberOfSpace) },
            },
        });
    }
}
exports.KaspiClient = KaspiClient;
exports.kaspiClient = new KaspiClient();
//# sourceMappingURL=kaspi.client.js.map