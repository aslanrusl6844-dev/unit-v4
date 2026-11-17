/**
 * Карта доставок My Market: заказы и поисковые запросы по городам приложения
 * (тот же список из 20 городов, что и в настройках приложения/«Картинки городов»),
 * плюс «машины в пути» — заказы picked/in_transit, сгруппированные по городу.
 * Хаб — Алматы. Всё считается только по каналу APP (ShopOrder / ShopEvent).
 */
export declare const HUB_CITY = "\u0410\u043B\u043C\u0430\u0442\u044B";
export type GeoOrderRow = {
    city: string;
    status: string;
    total: number;
    items: string;
    createdAt: Date;
    updatedAt: Date;
    deliveredAt: Date | null;
};
export type GeoSearchRow = {
    city: string | null;
    query: string | null;
    phone: string | null;
    id: string;
};
export type GeoCity = {
    city: string;
    orders: number;
    revenue: number;
    topItems: Array<{
        name: string;
        qty: number;
    }>;
    searches: number;
    topQueries: Array<{
        query: string;
        count: number;
    }>;
    paid: number;
    inTransit: number;
    transitSince: string | null;
    delivered: number;
    lastDeliveredAt: string | null;
};
/** Чистая функция — вся логика агрегации здесь, чтобы её можно было проверить тестом без БД. */
export declare function buildGeo(orders: GeoOrderRow[], searches: GeoSearchRow[]): {
    hub: string;
    cities: GeoCity[];
    otherOrders: number;
    otherSearches: number;
};
export declare function getGeoAnalytics(days: number): Promise<{
    hub: string;
    cities: GeoCity[];
    otherOrders: number;
    otherSearches: number;
}>;
