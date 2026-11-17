import { NormalizedOrder } from '../types';
/** Строка заказа из POST /api/seller/v1/orders/list (1 строка = 1 товарная позиция). */
export interface TeezOrderRow {
    orderId?: number;
    orderGuid?: string;
    orderNumber?: string | number;
    createdDate?: string;
    receivedDate?: string | null;
    statusKey?: string;
    statusLabel?: string;
    barcode?: string | null;
    productName?: string | null;
    quantity?: number;
    quantityReturned?: number;
    commissionPercent?: number;
    price?: number;
    originalPrice?: number | null;
    commissionAmount?: number;
    payoutAmount?: number;
    totalPrice?: number;
    totalCommissionAmount?: number;
    totalPayoutAmount?: number;
}
export interface TeezProductRow {
    productId: number;
    productName?: {
        rus?: string;
        kaz?: string;
    } | null;
    categoryName?: {
        rus?: string;
        kaz?: string;
    } | null;
    categoryId?: number;
    productStatus?: string;
    moderationStatus?: string;
    totalWmsQuantity?: number;
    salesCount?: number;
    photo?: {
        url?: string;
    } | null;
}
/** Статус Teez → наши статусы (те же слова, что у Kaspi, чтобы работали подписи и фильтры в панели). */
export declare function mapTeezStatus(statusKey: string | undefined, netQuantity: number): string;
/**
 * Одна строка заказа Teez → нормализованный заказ.
 * Деньги берём ровно те, что вернул Teez (комиссия и выплата посчитаны
 * площадкой), ничего не выдумываем. При частичном возврате считаем только
 * оставшиеся штуки.
 */
export declare function mapTeezOrder(row: TeezOrderRow): NormalizedOrder | null;
interface TeezCredentials {
    clientId: string;
    clientSecret: string;
}
declare class TeezClient {
    private token;
    private getCredentials;
    isConfigured(): Promise<boolean>;
    /** Сбросить кэш токена (после смены ключей в «Настройках»). */
    resetToken(): void;
    /** Токен авторизации; кэшируется до истечения (живёт ~1 час). */
    getToken(creds?: TeezCredentials): Promise<string>;
    /**
     * Диагностика при 404 на токене: три безопасных запроса БЕЗ настоящих ключей
     * (тестовые значения) — по ним видно, доступен ли сервер Teez с нашего хостинга
     * и существует ли путь. Возвращает короткую строку для сообщения об ошибке.
     */
    private probeEndpoints;
    /** Проверка ключей: удалось ли получить токен. Не бросает исключение. */
    testConnection(creds?: TeezCredentials): Promise<{
        ok: boolean;
        error?: string;
    }>;
    private post;
    /** Одна страница заказов; при отказе формата сортировки пробуем запасные варианты. */
    private fetchOrdersPage;
    /**
     * Заказы за период. У API нет фильтра по датам — идём по страницам от новых
     * к старым и останавливаемся, когда страница целиком старше dateFrom.
     * Если сортировку сервер не принял, читаем всё и фильтруем у себя.
     */
    fetchOrders(opts: {
        dateFrom: Date;
        dateTo: Date;
    }): Promise<NormalizedOrder[]>;
    /**
     * Детали товаров: POST /api/seller/v1/products/details (до 30 id за раз).
     * У каждого товара — SKU со штрихкодом (по нему приходят заказы), ценой и фото.
     */
    fetchProductDetails(productIds: number[]): Promise<TeezSkuDetail[]>;
    /** Список товаров магазина (статус, остаток, число продаж) — постранично, до конца. */
    fetchProducts(): Promise<TeezProductRow[]>;
}
export interface TeezSkuDetail {
    productId: number;
    name: string;
    skuId: number;
    barcode: string | null;
    price: number | null;
    photos: string[];
}
export declare const teezClient: TeezClient;
export {};
