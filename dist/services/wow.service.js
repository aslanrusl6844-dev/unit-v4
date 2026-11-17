"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WOW_DEFAULTS = exports.WOW_MAX_PERCENT = exports.WOW_MIN_PERCENT = void 0;
exports.wowPriceOf = wowPriceOf;
exports.activeWowPercent = activeWowPercent;
exports.normalizeWowPercent = normalizeWowPercent;
exports.addOneMonth = addOneMonth;
exports.effectiveStatus = effectiveStatus;
exports.givesDiscount = givesDiscount;
exports.applyWowToItems = applyWowToItems;
exports.getWowSettings = getWowSettings;
exports.getCurrentMembership = getCurrentMembership;
exports.membershipSavings = membershipSavings;
exports.pushToCustomer = pushToCustomer;
/**
 * Подписка «Вау» (как Coupang WOW): покупатель платит за месяц и получает скидку
 * на товары с меткой «Вау» (Product.wowPercent). Скидку считает ТОЛЬКО сервер.
 *
 * Пока нет онлайн-оплаты: покупатель нажимает «Подключить» → подписка в статусе
 * pending_payment → он переводит деньги → админ жмёт «Подтвердить оплату» → active на 1 месяц.
 * Возврат: если по подписке не было покупок со скидкой — деньги возвращаются полностью,
 * если были — подписка просто дотягивает до конца месяца без продления.
 */
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const pushBroadcast_service_1 = require("./pushBroadcast.service");
exports.WOW_MIN_PERCENT = 1;
exports.WOW_MAX_PERCENT = 30;
exports.WOW_DEFAULTS = { enabled: false, monthlyPrice: 2990, defaultPercent: 5, payInstructions: null };
/** Цена со скидкой «Вау» — целые тенге, округление к ближайшему. */
function wowPriceOf(price, percent) {
    if (!percent || !Number.isFinite(price) || price <= 0)
        return price;
    const p = Math.min(exports.WOW_MAX_PERCENT, Math.max(0, percent));
    return Math.round(price * (1 - p / 100));
}
/** Действующий процент «Вау» у товара: null, если метки нет или срок (wowUntil) уже прошёл. */
function activeWowPercent(p, now = new Date()) {
    if (!p.wowPercent)
        return null;
    if (p.wowUntil && new Date(p.wowUntil).getTime() <= now.getTime())
        return null;
    return p.wowPercent;
}
/** Нормальный процент для товара: целое 1..30 или null (снять метку). */
function normalizeWowPercent(raw) {
    if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0')
        return null;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < exports.WOW_MIN_PERCENT || n > exports.WOW_MAX_PERCENT)
        return null;
    return n;
}
/** Месяц вперёд от даты: 12 ноя → 12 дек; 31 янв → 28/29 фев (а не 3 марта). */
function addOneMonth(d) {
    const r = new Date(d.getTime());
    const day = r.getUTCDate();
    r.setUTCDate(1);
    r.setUTCMonth(r.getUTCMonth() + 1);
    const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
    r.setUTCDate(Math.min(day, last));
    return r;
}
/** Статус «на сейчас»: active с прошедшим endsAt — уже expired. */
function effectiveStatus(m, now = new Date()) {
    if (m.status === 'active' && m.endsAt && m.endsAt.getTime() <= now.getTime())
        return 'expired';
    return m.status;
}
/** Даёт ли подписка скидку сейчас. Ожидающая оплаты тоже даёт: заказ и подписку админ проверяет вместе. */
function givesDiscount(m, now = new Date()) {
    const s = effectiveStatus(m, now);
    return s === 'active' || s === 'pending_payment';
}
/**
 * Применяет скидку к позициям заказа. percentBySku — процент «Вау» по sku/артикулу товара.
 * Возвращает новые позиции (price уже со скидкой, basePrice — цена до скидки) и сумму скидки.
 */
function applyWowToItems(items, percentBySku) {
    let discount = 0;
    const out = items.map((i) => {
        const pct = percentBySku.get(i.sku);
        if (!pct)
            return i;
        const price = wowPriceOf(i.price, pct);
        if (price >= i.price)
            return i;
        discount += (i.price - price) * i.quantity;
        return { ...i, basePrice: i.price, price, wowPercent: pct };
    });
    return { items: out, discount: Math.round(discount) };
}
async function getWowSettings() {
    try {
        const s = await prisma_1.prisma.wowSettings.findUnique({ where: { id: 'main' } });
        if (!s)
            return { ...exports.WOW_DEFAULTS };
        return { enabled: s.enabled, monthlyPrice: s.monthlyPrice, defaultPercent: s.defaultPercent, payInstructions: s.payInstructions ?? null };
    }
    catch (err) {
        logger_1.logger.warn({ err }, '[Wow] настройки не прочитались — подписка считается выключенной');
        return { ...exports.WOW_DEFAULTS };
    }
}
/** Последняя подписка номера, которая сейчас даёт скидку (active или ожидает оплаты). */
async function getCurrentMembership(phone) {
    const rows = await prisma_1.prisma.wowMembership.findMany({
        where: { phone, status: { in: ['active', 'pending_payment'] } },
        orderBy: { createdAt: 'desc' },
        take: 5,
    });
    return rows.find((m) => givesDiscount(m)) ?? null;
}
/** Сколько сэкономлено и сколько заказов со скидкой по подписке (отменённые заказы не считаем). */
async function membershipSavings(membershipIds) {
    const map = new Map();
    for (const id of membershipIds)
        map.set(id, { saved: 0, orders: 0 });
    if (!membershipIds.length)
        return map;
    const orders = await prisma_1.prisma.shopOrder.findMany({
        where: { membershipId: { in: membershipIds }, wowDiscount: { gt: 0 }, status: { not: 'cancelled' } },
        select: { membershipId: true, wowDiscount: true },
    });
    for (const o of orders) {
        if (!o.membershipId)
            continue;
        const cur = map.get(o.membershipId) ?? { saved: 0, orders: 0 };
        cur.saved += o.wowDiscount;
        cur.orders += 1;
        map.set(o.membershipId, cur);
    }
    return map;
}
/** Пуш покупателю (на устройство, где он входил). Ошибки не роняют основное действие. */
async function pushToCustomer(phone, title, body) {
    try {
        const device = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
        if (!device?.token)
            return;
        await (0, pushBroadcast_service_1.sendBroadcast)({ title, body, tokens: [device.token], data: { type: 'wow' } });
    }
    catch (err) {
        logger_1.logger.warn({ err }, '[Wow] пуш покупателю не ушёл');
    }
}
//# sourceMappingURL=wow.service.js.map