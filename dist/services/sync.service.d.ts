export declare function syncKaspiOrders(dateFrom: Date, dateTo: Date): Promise<{
    ordersProcessed: number;
    productsCreated: number;
}>;
export declare function syncOzonOrders(dateFrom: Date, dateTo: Date): Promise<{
    ordersProcessed: number;
    productsCreated: number;
}>;
export declare function syncWbOrders(dateFrom: Date, dateTo: Date): Promise<{
    ordersProcessed: number;
    productsCreated: number;
}>;
/**
 * Синхронизация КАТАЛОГА (не заказов) — подтягивает список товаров,
 * которые СЕЙЧАС стоят на продаже на площадке, через собственный API
 * площадки "список товаров" (не через историю заказов). Создаёт новые
 * товары (себестоимость 0 — обязательно проставить вручную) и обновляет
 * название/статус активности уже существующих, НЕ трогая себестоимость,
 * которую пользователь мог уже проставить.
 */
/** Цена продажи с учётом акции Ozon: если товар сейчас в акции и цена там ниже — берём её. */
export declare function withActionPrice(price: number | undefined, productId: string | undefined, actionPrices: Map<string, number>, offerId?: string): number | undefined;
/**
 * Лёгкое обновление ТОЛЬКО цен и тарифов Ozon (без списка товаров и фото) — для частого
 * запуска раз в 5 минут: акция на Ozon снизила цену → у нас сразу та же цена и прибыль.
 */
export declare function syncOzonPrices(): Promise<{
    updated: number;
    skipped: "not-configured";
    total?: undefined;
    inActions?: undefined;
} | {
    updated: number;
    total: number;
    inActions: number;
    skipped?: undefined;
}>;
export declare function syncOzonCatalog(): Promise<{
    created: number;
    updated: number;
}>;
export declare function syncWbCatalog(): Promise<{
    created: number;
    updated: number;
    pricesFetched?: undefined;
    priceError?: undefined;
    subjectMissingCount?: undefined;
} | {
    created: number;
    updated: number;
    pricesFetched: number;
    priceError: string | null;
    subjectMissingCount: number;
}>;
/**
 * Фото Kaspi для товаров учёта — ПАЧКОЙ (по умолчанию 5 за вызов, чтобы
 * уложиться в лимит serverless-функции). Официальный API Kaspi фото не
 * отдаёт, поэтому читаем публичную страницу товара по kaspiProductUrl
 * (см. fetchProductImages). Товары без kaspiProductUrl пропускаются (ссылку
 * не угадываем) — их число возвращается в withoutUrl. Только чтение: на
 * Kaspi ничего не меняется. Проверенные товары помечаются marketImages
 * ("[]" = страница открылась, фото нет), чтобы не проверять их снова;
 * товары, чью страницу прочитать не удалось, остаются непроверенными.
 */
export declare function syncKaspiPhotos(limit?: number, excludeIds?: string[]): Promise<{
    checked: number;
    withPhotos: number;
    failedIds: string[];
    remaining: number;
    withoutUrl: number;
}>;
/** Ключ словаря: тип Ozon без учёта регистра и лишних пробелов. */
export declare function ozonTypeKey(name: string): string;
/**
 * Описание, состав/характеристики, фото и категория для КАРТОЧЕК My Market из
 * данных Ozon — только для товаров, которые уже есть в базе (по ozonOfferId).
 * Пачками (по умолчанию 40) с курсором, чтобы уложиться в лимит serverless.
 *
 * Правила (см. ТЗ):
 *  - description / composition пишутся, если поле пустое или его раньше
 *    записал этот же синк (*Source = "ozon"); поле, которое правили руками,
 *    не трогаем;
 *  - images витрины — только если поле пустое, из marketImages (фото Ozon);
 *  - category/type — ТОЛЬКО через словарь OzonTypeMap по типу Ozon. Нет записи
 *    в словаре — остаются пустыми. Тип по названию не угадываем, сырую
 *    категорию Ozon не пишем;
 *  - shopActive, shopPrice, shopStock, subcategory не трогаются вообще.
 */
export declare function syncOzonContent(limit?: number, cursor?: string): Promise<{
    processed: number;
    updated: number;
    withDescription: number;
    mapped: number;
    unmappedTypes: string[];
    nextCursor: string | null;
    done: boolean;
}>;
