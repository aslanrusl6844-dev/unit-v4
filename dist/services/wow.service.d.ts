export declare const WOW_MIN_PERCENT = 1;
export declare const WOW_MAX_PERCENT = 30;
export type WowStatus = 'pending_payment' | 'active' | 'refund_requested' | 'refunded' | 'cancelled' | 'expired';
export interface WowSettingsDto {
    enabled: boolean;
    monthlyPrice: number;
    defaultPercent: number;
    payInstructions: string | null;
}
export declare const WOW_DEFAULTS: WowSettingsDto;
/** Цена со скидкой «Вау» — целые тенге, округление к ближайшему. */
export declare function wowPriceOf(price: number, percent: number | null | undefined): number;
/** Действующий процент «Вау» у товара: null, если метки нет или срок (wowUntil) уже прошёл. */
export declare function activeWowPercent(p: {
    wowPercent?: number | null;
    wowUntil?: Date | string | null;
}, now?: Date): number | null;
/** Нормальный процент для товара: целое 1..30 или null (снять метку). */
export declare function normalizeWowPercent(raw: unknown): number | null;
/** Месяц вперёд от даты: 12 ноя → 12 дек; 31 янв → 28/29 фев (а не 3 марта). */
export declare function addOneMonth(d: Date): Date;
type Membership = {
    id: string;
    phone: string;
    status: string;
    price: number;
    endsAt: Date | null;
    startsAt: Date | null;
    paidAt: Date | null;
    createdAt: Date;
    cancelRequested: boolean;
    customerName: string | null;
};
/** Статус «на сейчас»: active с прошедшим endsAt — уже expired. */
export declare function effectiveStatus(m: Pick<Membership, 'status' | 'endsAt'>, now?: Date): WowStatus;
/** Даёт ли подписка скидку сейчас. Ожидающая оплаты тоже даёт: заказ и подписку админ проверяет вместе. */
export declare function givesDiscount(m: Pick<Membership, 'status' | 'endsAt'>, now?: Date): boolean;
export interface WowOrderItem {
    sku: string;
    name: string;
    price: number;
    quantity: number;
    [k: string]: unknown;
}
/**
 * Применяет скидку к позициям заказа. percentBySku — процент «Вау» по sku/артикулу товара.
 * Возвращает новые позиции (price уже со скидкой, basePrice — цена до скидки) и сумму скидки.
 */
export declare function applyWowToItems(items: WowOrderItem[], percentBySku: Map<string, number>): {
    items: WowOrderItem[];
    discount: number;
};
export declare function getWowSettings(): Promise<WowSettingsDto>;
/** Последняя подписка номера, которая сейчас даёт скидку (active или ожидает оплаты). */
export declare function getCurrentMembership(phone: string): Promise<Membership | null>;
/** Сколько сэкономлено и сколько заказов со скидкой по подписке (отменённые заказы не считаем). */
export declare function membershipSavings(membershipIds: string[]): Promise<Map<string, {
    saved: number;
    orders: number;
}>>;
/** Пуш покупателю (на устройство, где он входил). Ошибки не роняют основное действие. */
export declare function pushToCustomer(phone: string, title: string, body: string): Promise<void>;
export {};
