import { NormalizedOrder } from '../types';
/**
 * Клиент для "Магазин на Kaspi.kz" API (JSON:API формат).
 * Документация: https://guide.kaspi.kz/partner/ru/shop/api/general
 *
 * ВАЖНО: Kaspi время от времени меняет названия query-параметров фильтрации
 * заказов (state/status, диапазоны дат). Если после запуска сервера заказы
 * не подтягиваются — сверьте параметры ниже с актуальным разделом
 * "Заказы" в Kaspi Гид для партнёров и поправьте buildOrdersQuery().
 *
 * Токен для запросов берётся ДИНАМИЧЕСКИ: сначала пробуем найти сохранённый
 * магазин в базе (форма «Добавить магазин» в разделе «Настройки»), и только
 * если его нет — используем KASPI_API_TOKEN из переменных окружения (для
 * обратной совместимости с тем, кто настраивал сервер до появления формы).
 */
interface KaspiCredentials {
    token: string;
    baseUrl: string;
    merchantUid: string;
}
export declare function getKaspiCredentials(): Promise<KaspiCredentials | null>;
export interface KaspiFetchedOrder {
    order: NormalizedOrder;
}
export declare class KaspiClient {
    /** true/false — есть ли вообще откуда взять токен (БД или .env). */
    isConfigured(): Promise<boolean>;
    private getHttp;
    /**
     * Разбивает период на куски не длиннее maxDays — у Kaspi есть жёсткое
     * ограничение на диапазон filter[orders][creationDate] (точное сообщение
     * от их API: "Exceeded the maximum difference for the filter[orders]
     * [creationDate] (in days). Actual [30], max [14]."). Если запросить
     * сразу 30 или 90 дней, Kaspi вернёт 400 — поэтому режем на куски по
     * 14 дней и опрашиваем каждый кусок отдельно.
     */
    private static chunkDateRange;
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
    fetchOrders(params: {
        dateFrom: Date;
        dateTo: Date;
        pageSize?: number;
    }): Promise<NormalizedOrder[]>;
    /** Один state + один кусок дат — со своей постраничной пагинацией внутри. */
    private fetchOrdersForStateAndChunk;
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
    private fetchOrderEntries;
    /**
     * Полная детализация ОДНОЙ позиции заказа — GET /orderentries/{entryId}
     * (не список, а именно один элемент). Только тут Kaspi отдаёт category
     * ({code, title}) и вес — списочный метод /orders/{id}/entries их не
     * содержит. Официально задокументировано в Kaspi Гид (q3204).
     */
    private fetchEntryDetail;
    /** Название и код товара по id позиции заказа — отдельный запрос, см. комментарий выше. */
    private fetchEntryProduct;
    private toNormalizedOrder;
    /**
     * Принять новый заказ (перевести в статус ACCEPTED_BY_MERCHANT).
     * См. Kaspi Гид: "Как принять новый заказ?"
     */
    acceptOrder(kaspiInternalId: string, code: string): Promise<void>;
    /**
     * Сформировать накладную для передачи заказа на Kaspi Доставку —
     * технически это перевод заказа в статус ASSEMBLE с указанием количества
     * мест (коробок/упаковок). После этого печатную накладную можно скачать
     * в личном кабинете Kaspi — API не отдаёт готовый PDF, только меняет статус.
     * См. Kaspi Гид: "Как сформировать накладную для передачи заказа на Kaspi Доставку?"
     */
    formWaybill(kaspiInternalId: string, numberOfSpace: number): Promise<void>;
}
export declare const kaspiClient: KaspiClient;
export {};
