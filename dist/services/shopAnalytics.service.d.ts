/**
 * Белый список городов приложения — ТОЛЬКО эти 14, как в адресе заказа.
 * Регистр не важен, "Нур-Султан" — алиас на "Астана". Всё остальное —
 * не из списка, считается "без города" (см. normalizeKzCity) — город не
 * выдумываем, если его нет в этом списке.
 */
export declare const KZ_CITY_WHITELIST: string[];
/** trim + регистр не важен; не из списка (или пусто) -> null ("без города"). */
export declare function normalizeKzCity(raw: string | null): string | null;
/**
 * А) Поисковые запросы — под каждой строкой одна подстрока с городами
 * ЭТОГО запроса: только из белого списка, формат "Город N · Город N",
 * сортировка по числу людей убыв., затем "Всего по РК: N" (сумма только
 * по белому списку), и если есть события с городом не из списка/пустым —
 * отдельной пометкой "без города: N" в конце (город не выдумываем).
 */
export declare function getSearchAnalytics(days: number): Promise<{
    query: string;
    searchCount: number;
    uniquePeople: number;
    orderedAfterSearch: number;
    orderedRevenue: number;
    avgResultsCount: number | null;
    zeroResultsCount: number;
    cityBreakdown: {
        city: string;
        count: number;
    }[];
    totalRk: number;
    noCityCount: number;
}[]>;
/** Б) Конверсия по SKU — товары без событий (ни view, ни cart) не показываем. */
export declare function getConversionAnalytics(days: number): Promise<{
    sku: string;
    name: string;
    views: number;
    cart: number;
    orders: number;
    payments: number;
    cartPct: number;
    orderPct: number;
}[]>;
/** В) Сезонность по дням + отдельная таблица городов (белый список). */
export declare function getSeasonalityAnalytics(days: number): Promise<{
    daily: {
        date: string;
        searches: number;
        cart: number;
        orders: number;
        paidRevenue: number;
    }[];
    cities: {
        city: string;
        searches: number;
        uniquePeople: number;
        orders: number;
        revenue: number;
    }[];
}>;
