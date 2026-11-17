"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discountPercent = discountPercent;
exports.shortName = shortName;
exports.reminderText = reminderText;
exports.reminderTitle = reminderTitle;
exports.firstNameOf = firstNameOf;
exports.runCartReminders = runCartReminders;
exports.runReminderKind = runReminderKind;
exports.sendTestReminder = sendTestReminder;
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const pushBroadcast_service_1 = require("./pushBroadcast.service");
const KIND = {
    cart: { from: 72, to: 48, dataType: 'cart_reminder' },
    view: { from: 48, to: 24, dataType: 'view_reminder' },
};
const LOW_STOCK = 3;
const HOUR = 3600_000;
const MAX_PER_RUN = 200;
const PARALLEL = 10;
const normPhone = (raw) => {
    const d = String(raw ?? '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8')
        return '7' + d.slice(1);
    if (d.length === 11 && d[0] === '7')
        return d;
    if (d.length === 10)
        return '7' + d;
    return null;
};
function discountPercent(price, oldPrice) {
    const p = Number(price), o = Number(oldPrice);
    if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 0 || p < 0 || o <= p)
        return null;
    const pct = Math.round(((o - p) / o) * 100);
    return pct >= 1 ? pct : null;
}
/** Короткое название для пуша: до запятой/скобки, не больше 4 слов и ~32 символов («Соковыжималка 1200 Вт центробежная…» → «Соковыжималка 1200 Вт центробежная»). */
function shortName(name) {
    const head = name.trim().split(/[,(\[|;]/)[0].trim();
    let out = head.split(/\s+/).slice(0, 4).join(' ');
    while (out.length > 32 && out.includes(' '))
        out = out.slice(0, out.lastIndexOf(' '));
    return out.length > 32 ? `${out.slice(0, 31)}…` : out;
}
/**
 * Текст пуша. С большой картинкой Android показывает только ~2 строки (≈70 знаков), поэтому скидку
 * не повторяем — она уже в заголовке; в тексте только имя, товар и одно короткое действие.
 */
function reminderText(name, _pct, opts = {}) {
    const n = shortName(name);
    const lead = opts.kind === 'view'
        ? `${opts.firstName ? `${opts.firstName}, вы` : 'Вы'} смотрели: ${n}.`
        : `${opts.firstName ? `${opts.firstName}, у вас` : 'У вас'} в корзине: ${n}.`;
    const low = opts.stock != null && opts.stock > 0 && opts.stock <= LOW_STOCK;
    return low ? `${lead} Осталось ${opts.stock} шт.` : `${lead} Успейте купить`;
}
/** Заголовок пуша: как у Coupang — сразу выгода (название приложения телефон пишет сам). */
function reminderTitle(kind, pct) {
    if (kind === 'cart')
        return pct ? `Скидка ${pct}% ↓ на товар в корзине` : 'Товар ждёт в корзине';
    return pct ? `Скидка ${pct}% ↓` : 'Вы смотрели этот товар';
}
/** Имя из последнего заказа номера («Аслан Тушкеев» → «Аслан»); нет заказов — без имени. */
function firstNameOf(customerName) {
    const w = String(customerName ?? '').trim().split(/\s+/)[0] ?? '';
    return /^[\p{L}-]{2,20}$/u.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : null;
}
function phoneVariants(ph) {
    const d = ph.slice(1);
    return [ph, `+${ph}`, `8${d}`, d, `+7 ${d}`];
}
function firstImage(p) {
    try {
        const arr = p.images ? JSON.parse(p.images) : [];
        const u = Array.isArray(arr) ? arr.find((x) => typeof x === 'string' && /^https:\/\/\S+$/i.test(x)) : null;
        return u ?? null;
    }
    catch {
        return null;
    }
}
/** Оба вида за один запуск: сначала корзина, потом просмотры (один пуш в сутки на номер). */
async function runCartReminders(now = new Date()) {
    const a = await runReminderKind('cart', now);
    const b = await runReminderKind('view', now);
    return { candidates: a.candidates + b.candidates, sent: a.sent + b.sent, skipped: a.skipped + b.skipped, failed: a.failed + b.failed };
}
async function runReminderKind(kind, now = new Date()) {
    const cfg = KIND[kind];
    const res = { candidates: 0, sent: 0, skipped: 0, failed: 0 };
    const windowStart = new Date(now.getTime() - cfg.from * HOUR);
    const cutoff = new Date(now.getTime() - cfg.to * HOUR);
    const dayAgo = new Date(now.getTime() - 24 * HOUR);
    const events = await prisma_1.prisma.shopEvent.findMany({
        where: { type: kind, createdAt: { gte: windowStart }, phone: { not: null }, sku: { not: null } },
        orderBy: { createdAt: 'desc' },
    });
    // последнее событие по номеру
    const latest = new Map();
    for (const e of events) {
        const ph = normPhone(e.phone);
        if (ph && !latest.has(ph))
            latest.set(ph, e);
    }
    const eligible = [...latest.entries()].filter(([, e]) => new Date(e.createdAt) <= cutoff).slice(0, MAX_PER_RUN);
    res.candidates = eligible.length;
    if (!eligible.length)
        return res;
    // заказы/оплаты после корзины
    const orders = await prisma_1.prisma.shopOrder.findMany({ where: { createdAt: { gte: windowStart } } });
    const orderTimes = new Map();
    for (const o of orders) {
        if (o.status === 'cancelled')
            continue;
        const ph = normPhone(o.phone);
        if (ph)
            orderTimes.set(ph, [...(orderTimes.get(ph) ?? []), new Date(o.createdAt).getTime()]);
    }
    // Для просмотров «дальше по воронке» — ещё и корзина: ей займётся напоминание о корзине.
    const doneTypes = kind === 'view' ? ['order', 'paid', 'cart'] : ['order', 'paid'];
    const doneEvents = await prisma_1.prisma.shopEvent.findMany({ where: { type: { in: doneTypes }, createdAt: { gte: windowStart }, phone: { not: null } } });
    for (const o of doneEvents) {
        const ph = normPhone(o.phone);
        if (ph)
            orderTimes.set(ph, [...(orderTimes.get(ph) ?? []), new Date(o.createdAt).getTime()]);
    }
    const recent = await prisma_1.prisma.cartReminder.findMany({ where: { sentAt: { gte: dayAgo } } });
    const recentPhones = new Set(recent.map((r) => r.phone));
    const work = async ([phone, ev]) => {
        try {
            if ((orderTimes.get(phone) ?? []).some((t) => t >= new Date(ev.createdAt).getTime())) {
                res.skipped++;
                return;
            }
            if (recentPhones.has(phone)) {
                res.skipped++;
                return;
            }
            const products = await prisma_1.prisma.product.findMany({ where: { OR: [{ sku: ev.sku }, { shopArticle: ev.sku }] }, take: 1 });
            const product = products[0];
            if (!product || !product.shopActive || product.shopArchived || product.shopPrice == null || (product.shopStock != null && product.shopStock <= 0)) {
                res.skipped++;
                return;
            }
            const rec = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
            if (!rec?.token) {
                res.skipped++;
                return;
            }
            // «Занимаем» событие до отправки: параллельный запуск не пришлёт второй раз.
            try {
                await prisma_1.prisma.cartReminder.create({ data: { eventId: ev.id, phone, sku: String(ev.sku), kind } });
                recentPhones.add(phone);
            }
            catch {
                res.skipped++;
                return; // уже напоминали (уникальный eventId)
            }
            const lastOrder = await prisma_1.prisma.shopOrder.findMany({ where: { phone: { in: phoneVariants(phone) } }, orderBy: { createdAt: 'desc' }, take: 1 });
            const firstName = firstNameOf(lastOrder[0]?.customerName);
            const pct = discountPercent(product.shopPrice, product.shopOldPrice);
            const r = await (0, pushBroadcast_service_1.sendBroadcast)({
                title: reminderTitle(kind, pct),
                body: reminderText(product.name, pct, { kind, firstName, stock: product.shopStock }),
                imageUrl: firstImage(product),
                tokens: [rec.token],
                data: { type: cfg.dataType, screen: kind === 'cart' ? 'cart' : 'product', productId: String(product.id), sku: String(product.sku), shopArticle: String(product.shopArticle ?? '') },
            });
            if (r.sent > 0)
                res.sent++;
            else {
                res.failed++;
                logger_1.logger.error({ phone, failed: r.failed, fcmError: r.fcmError }, '[CartReminder] Пуш не принят');
            }
        }
        catch (err) {
            res.failed++;
            logger_1.logger.error({ err: String(err?.message ?? err) }, '[CartReminder] Ошибка по номеру');
        }
    };
    for (let i = 0; i < eligible.length; i += PARALLEL)
        await Promise.all(eligible.slice(i, i + PARALLEL).map(work));
    logger_1.logger.info(res, `[CartReminder] Проверка завершена (${kind})`);
    return res;
}
/**
 * Пробный пуш из админки (Рассылка → «Пример напоминания»): последний просмотренный / положенный в корзину
 * товар номера, без окон по времени и без записи в журнал — чтобы увидеть, как выглядит настоящее напоминание.
 */
async function sendTestReminder(kind, rawPhone) {
    const phone = normPhone(rawPhone);
    if (!phone)
        return { ok: false, message: 'Неверный номер' };
    const rec = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
    if (!rec?.token)
        return { ok: false, message: 'У номера нет разрешения на пуши (приложение не входило с этим номером)' };
    const events = await prisma_1.prisma.shopEvent.findMany({
        where: { type: kind, phone: { in: phoneVariants(phone) }, sku: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 20,
    });
    for (const ev of events) {
        const products = await prisma_1.prisma.product.findMany({ where: { OR: [{ sku: ev.sku }, { shopArticle: ev.sku }] }, take: 1 });
        const product = products[0];
        if (!product || !product.shopActive || product.shopArchived || product.shopPrice == null)
            continue;
        const lastOrder = await prisma_1.prisma.shopOrder.findMany({ where: { phone: { in: phoneVariants(phone) } }, orderBy: { createdAt: 'desc' }, take: 1 });
        const pct = discountPercent(product.shopPrice, product.shopOldPrice);
        const r = await (0, pushBroadcast_service_1.sendBroadcast)({
            title: reminderTitle(kind, pct),
            body: reminderText(product.name, pct, { kind, firstName: firstNameOf(lastOrder[0]?.customerName), stock: product.shopStock }),
            imageUrl: firstImage(product),
            tokens: [rec.token],
            data: { type: KIND[kind].dataType, screen: kind === 'cart' ? 'cart' : 'product', productId: String(product.id), sku: String(product.sku), shopArticle: String(product.shopArticle ?? '') },
        });
        return r.sent > 0
            ? { ok: true, message: `Отправлено: ${product.name}` }
            : { ok: false, message: `Пуш не принят: ${r.fcmError ?? 'ошибка доставки'}` };
    }
    return { ok: false, message: kind === 'view' ? 'Этот номер ещё не смотрел товары в продаже' : 'У этого номера нет товаров в корзине' };
}
//# sourceMappingURL=cartReminder.service.js.map