"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YardTransitionError = exports.YARD_PAID_OR_LATER = exports.YARD_SELLER_DETAIL_STATUSES = exports.YARD_PHONE_VISIBLE_STATUSES = exports.YARD_DEFAULT_RADIUS = exports.YARD_RADIUS_OPTIONS = exports.YARD_RADIUS_METERS = void 0;
exports.yardShopRadius = yardShopRadius;
exports.yardParseBuyerRadius = yardParseBuyerRadius;
exports.yardAppStatus = yardAppStatus;
exports.yardOrderDistance = yardOrderDistance;
exports.yardDistanceMeters = yardDistanceMeters;
exports.yardShopIsLive = yardShopIsLive;
exports.generateYardPublicId = generateYardPublicId;
exports.yardApplyPayment = yardApplyPayment;
exports.yardApplyAccept = yardApplyAccept;
exports.yardApplyClose = yardApplyClose;
const prisma_1 = require("../db/prisma");
/**
 * Устарело: прежний общий радиус. Теперь радиус у каждого магазина
 * (YardShop.radiusMeters), у покупателя — параметр radius. Константа оставлена
 * только для совместимости импортов.
 */
exports.YARD_RADIUS_METERS = 400;
/** Радиусы, из которых магазин выбирает свой (метры). Считает сервер, не приложение. */
exports.YARD_RADIUS_OPTIONS = [200, 300, 500, 1000];
exports.YARD_DEFAULT_RADIUS = 500;
/** Радиус магазина; у строки без значения (или с неверным) — 500. */
function yardShopRadius(shop) {
    const r = shop.radiusMeters;
    return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : exports.YARD_DEFAULT_RADIUS;
}
/**
 * Радиус покупателя из query: нет параметра → 500; число > 0 → оно; иначе null
 * (неверное значение — ошибка запроса, а не молчаливая подмена).
 */
function yardParseBuyerRadius(raw) {
    if (raw === undefined || raw === '')
        return exports.YARD_DEFAULT_RADIUS;
    if (typeof raw !== 'string')
        return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= 100000 ? n : null;
}
/** Номер магазина и покупателя виден только после «Принял». */
exports.YARD_PHONE_VISIBLE_STATUSES = ['accepted', 'at_door', 'done', 'not_picked', 'out_of_stock'];
/**
 * Кому продавец видит адрес доставки (подъезд, этаж, квартира, домофон) и расстояние:
 * сразу после «Оплачено» — до оплаты адрес не показываем. Номер покупателя продавец
 * видит с самого начала: он и так есть в чате (GET /yard/shops/:id/messages), а по нему
 * приложение находит заказ для кнопки «Подтвердить оплату».
 */
exports.YARD_SELLER_DETAIL_STATUSES = ['paid', 'accepted', 'at_door', 'done', 'not_picked', 'out_of_stock'];
/** Статусы заказа, после которых «Оплачено» повторять не нужно (повторное нажатие — не ошибка). */
exports.YARD_PAID_OR_LATER = ['paid', 'accepted', 'at_door', 'done'];
/** Статус для приложения: оно знает new / paid / accepted / rejected. Реальный статус отдаём в serverStatus. */
function yardAppStatus(status) {
    if (status === 'waiting_payment')
        return 'waiting_payment';
    if (status === 'paid')
        return 'paid';
    if (status === 'accepted' || status === 'at_door' || status === 'done')
        return 'accepted';
    if (status === 'no_payment' || status === 'not_picked' || status === 'out_of_stock')
        return 'rejected';
    return status;
}
/** Расстояние от точки заказа до магазина, м. Нет координат (или 0,0) — null. */
function yardOrderDistance(order, shop) {
    if (typeof order.lat !== 'number' || typeof order.lng !== 'number')
        return null;
    if (order.lat === 0 && order.lng === 0)
        return null;
    return Math.round(yardDistanceMeters(order.lat, order.lng, shop.lat, shop.lng));
}
class YardTransitionError extends Error {
    status;
    constructor(message, status = 409) {
        super(message);
        this.name = 'YardTransitionError';
        this.status = status;
    }
}
exports.YardTransitionError = YardTransitionError;
function yardDistanceMeters(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
/** Покупателю виден только включённый магазин с живой подпиской. */
function yardShopIsLive(shop) {
    return shop.active && !!shop.paidUntil && shop.paidUntil.getTime() > Date.now();
}
async function generateYardPublicId() {
    const now = new Date();
    const day = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    for (let attempt = 0; attempt < 8; attempt++) {
        const tail = String(Math.floor(1000 + Math.random() * 9000));
        const publicId = `YD-${day}-${tail}`;
        const existing = await prisma_1.prisma.yardOrder.findUnique({ where: { publicId }, select: { id: true } });
        if (!existing)
            return publicId;
    }
    throw new YardTransitionError('Не удалось выдать номер заказа', 500);
}
async function loadOrder(orderId) {
    const order = await prisma_1.prisma.yardOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
    });
    if (!order)
        throw new YardTransitionError('Заказ не найден', 404);
    return order;
}
/** «Оплата есть» списывает полку. «Оплаты нет» гасит заказ и остаток не трогает. */
async function yardApplyPayment(orderId, ok) {
    const order = await loadOrder(orderId);
    if (order.status !== 'waiting_payment') {
        throw new YardTransitionError('Оплату можно отметить только у заказа, который ждёт оплату');
    }
    if (!ok) {
        return prisma_1.prisma.yardOrder.update({ where: { id: orderId }, data: { status: 'no_payment' }, include: { items: true } });
    }
    return prisma_1.prisma.$transaction(async (tx) => {
        for (const line of order.items) {
            if (!line.itemId)
                continue;
            const item = await tx.yardItem.findUnique({ where: { id: line.itemId } });
            if (!item || item.stock < line.qty) {
                throw new YardTransitionError(`На полке недостаточно «${line.name}»`);
            }
            await tx.yardItem.update({ where: { id: line.itemId }, data: { stock: { decrement: line.qty } } });
        }
        return tx.yardOrder.update({ where: { id: orderId }, data: { status: 'paid', paidAt: new Date() }, include: { items: true } });
    });
}
/** «Принял» — только после оплаты. С этого момента номер виден второй стороне. */
async function yardApplyAccept(orderId) {
    const order = await loadOrder(orderId);
    if (order.status !== 'paid')
        throw new YardTransitionError('Принять можно только оплаченный заказ');
    return prisma_1.prisma.yardOrder.update({ where: { id: orderId }, data: { status: 'accepted' }, include: { items: true } });
}
/** «Выдан» не трогает полку. «Не забрали» и «Нет в наличии» возвращают остаток. */
async function yardApplyClose(orderId, status) {
    const order = await loadOrder(orderId);
    if (order.status !== 'accepted' && order.status !== 'at_door') {
        throw new YardTransitionError('Закрыть можно только принятый заказ');
    }
    if (status === 'not_picked' || status === 'out_of_stock') {
        for (const line of order.items) {
            if (!line.itemId)
                continue;
            await prisma_1.prisma.yardItem.update({ where: { id: line.itemId }, data: { stock: { increment: line.qty } } });
        }
    }
    return prisma_1.prisma.yardOrder.update({ where: { id: orderId }, data: { status }, include: { items: true } });
}
//# sourceMappingURL=yard.service.js.map