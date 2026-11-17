/**
 * Устарело: прежний общий радиус. Теперь радиус у каждого магазина
 * (YardShop.radiusMeters), у покупателя — параметр radius. Константа оставлена
 * только для совместимости импортов.
 */
export declare const YARD_RADIUS_METERS = 400;
/** Радиусы, из которых магазин выбирает свой (метры). Считает сервер, не приложение. */
export declare const YARD_RADIUS_OPTIONS: readonly [200, 300, 500, 1000];
export declare const YARD_DEFAULT_RADIUS = 500;
/** Радиус магазина; у строки без значения (или с неверным) — 500. */
export declare function yardShopRadius(shop: {
    radiusMeters?: number | null;
}): number;
/**
 * Радиус покупателя из query: нет параметра → 500; число > 0 → оно; иначе null
 * (неверное значение — ошибка запроса, а не молчаливая подмена).
 */
export declare function yardParseBuyerRadius(raw: unknown): number | null;
/** Номер магазина и покупателя виден только после «Принял». */
export declare const YARD_PHONE_VISIBLE_STATUSES: string[];
/**
 * Кому продавец видит адрес доставки (подъезд, этаж, квартира, домофон) и расстояние:
 * сразу после «Оплачено» — до оплаты адрес не показываем. Номер покупателя продавец
 * видит с самого начала: он и так есть в чате (GET /yard/shops/:id/messages), а по нему
 * приложение находит заказ для кнопки «Подтвердить оплату».
 */
export declare const YARD_SELLER_DETAIL_STATUSES: string[];
/** Статусы заказа, после которых «Оплачено» повторять не нужно (повторное нажатие — не ошибка). */
export declare const YARD_PAID_OR_LATER: string[];
/** Статус для приложения: оно знает new / paid / accepted / rejected. Реальный статус отдаём в serverStatus. */
export declare function yardAppStatus(status: string): string;
/** Расстояние от точки заказа до магазина, м. Нет координат (или 0,0) — null. */
export declare function yardOrderDistance(order: {
    lat?: number | null;
    lng?: number | null;
}, shop: {
    lat: number;
    lng: number;
}): number | null;
export declare class YardTransitionError extends Error {
    status: number;
    constructor(message: string, status?: number);
}
export declare function yardDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number;
/** Покупателю виден только включённый магазин с живой подпиской. */
export declare function yardShopIsLive(shop: {
    active: boolean;
    paidUntil: Date | null;
}): boolean;
export declare function generateYardPublicId(): Promise<string>;
/** «Оплата есть» списывает полку. «Оплаты нет» гасит заказ и остаток не трогает. */
export declare function yardApplyPayment(orderId: string, ok: boolean): Promise<{
    items: {
        name: string;
        id: string;
        price: number;
        orderId: string;
        qty: number;
        itemId: string | null;
    }[];
} & {
    status: string;
    id: string;
    createdAt: Date;
    total: number;
    apartment: string | null;
    entrance: string | null;
    floor: string | null;
    intercom: string | null;
    paidAt: Date | null;
    archived: boolean;
    lat: number | null;
    address: string | null;
    publicId: string;
    shopId: string;
    buyerPhone: string;
    buyerName: string;
    lng: number | null;
}>;
/** «Принял» — только после оплаты. С этого момента номер виден второй стороне. */
export declare function yardApplyAccept(orderId: string): Promise<{
    items: {
        name: string;
        id: string;
        price: number;
        orderId: string;
        qty: number;
        itemId: string | null;
    }[];
} & {
    status: string;
    id: string;
    createdAt: Date;
    total: number;
    apartment: string | null;
    entrance: string | null;
    floor: string | null;
    intercom: string | null;
    paidAt: Date | null;
    archived: boolean;
    lat: number | null;
    address: string | null;
    publicId: string;
    shopId: string;
    buyerPhone: string;
    buyerName: string;
    lng: number | null;
}>;
/** «Выдан» не трогает полку. «Не забрали» и «Нет в наличии» возвращают остаток. */
export declare function yardApplyClose(orderId: string, status: 'done' | 'not_picked' | 'out_of_stock'): Promise<{
    items: {
        name: string;
        id: string;
        price: number;
        orderId: string;
        qty: number;
        itemId: string | null;
    }[];
} & {
    status: string;
    id: string;
    createdAt: Date;
    total: number;
    apartment: string | null;
    entrance: string | null;
    floor: string | null;
    intercom: string | null;
    paidAt: Date | null;
    archived: boolean;
    lat: number | null;
    address: string | null;
    publicId: string;
    shopId: string;
    buyerPhone: string;
    buyerName: string;
    lng: number | null;
}>;
