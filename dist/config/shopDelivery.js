"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DELIVERY_FEE = exports.FREE_DELIVERY_FROM = void 0;
exports.deliveryFeeFor = deliveryFeeFor;
exports.deliveryFeeOfOrder = deliveryFeeOfOrder;
/**
 * Доставка заказов магазина My Market по Казахстану.
 * Правило из оферты mymarket.kz: при сумме товаров менее 10 000 ₸ доставка 1 000 ₸,
 * при сумме от 10 000 ₸ и более — бесплатно. Меняется здесь и в приложении
 * (ShopConfig.kt: FREE_DELIVERY_FROM / DELIVERY_FEE) одновременно.
 */
exports.FREE_DELIVERY_FROM = 10_000;
exports.DELIVERY_FEE = 1_000;
/** Стоимость доставки по сумме товаров (до бонусов), в тенге. */
function deliveryFeeFor(itemsSubtotal) {
    if (!Number.isFinite(itemsSubtotal) || itemsSubtotal <= 0)
        return 0;
    return itemsSubtotal >= exports.FREE_DELIVERY_FROM ? 0 : exports.DELIVERY_FEE;
}
/** Сколько доставки в уже созданном заказе: итог минус сумма позиций (старые заказы — 0). */
function deliveryFeeOfOrder(total, items) {
    const sum = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
    return Math.max(0, Math.round(total - sum));
}
//# sourceMappingURL=shopDelivery.js.map