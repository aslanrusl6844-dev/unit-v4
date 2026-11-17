"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ruDate = ruDate;
exports.ruDateTime = ruDateTime;
exports.expressPromiseDate = expressPromiseDate;
exports.buildDelivery = buildDelivery;
const cities_1 = require("../config/cities");
const delivery_1 = require("../config/delivery");
/**
 * «Ход доставки» заказа для приложения: готовые подписи и шаги, приложение их только рисует.
 *  - Алматы: курьер привозит на следующий день (иконка «ракета»);
 *  - другие города: машина едет из Алматы несколько дней (иконка «грузовик»), «День 2 из 3 …»,
 *    потом заказ берёт местный курьер. Положение по дням — оценка по времени «Машина выехала»,
 *    не GPS: админ нажимает «Машина выехала» / «Машина прибыла».
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** Компоненты даты по времени Алматы. */
function local(d) {
    const t = new Date(d.getTime() + delivery_1.ALMATY_UTC_OFFSET_HOURS * 3600 * 1000);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth(), day: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes(), dow: t.getUTCDay() };
}
/** Номер дня по Алматы (для разницы «сегодня/завтра»). */
function dayNumber(d) {
    return Math.floor((d.getTime() + delivery_1.ALMATY_UTC_OFFSET_HOURS * 3600 * 1000) / DAY_MS);
}
function ruDate(d) {
    const l = local(d);
    return `${l.day} ${MONTHS_GEN[l.m]}`;
}
function ruDateTime(d) {
    const l = local(d);
    return `${l.day} ${MONTHS_SHORT[l.m]}, ${String(l.h).padStart(2, '0')}:${String(l.min).padStart(2, '0')}`;
}
function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }
/** День, к которому курьер привезёт заказ по Алматы: оплата до 18:00 → завтра, позже → послезавтра; без воскресенья, если так настроено. */
function expressPromiseDate(paidAt) {
    const l = local(paidAt);
    let target = addDays(paidAt, l.h >= delivery_1.EXPRESS_CUTOFF_HOUR ? 2 : 1);
    if (!delivery_1.COURIER_WORKS_ON_SUNDAY && local(target).dow === 0)
        target = addDays(target, 1);
    return target;
}
function relativeDay(target, now) {
    const diff = dayNumber(target) - dayNumber(now);
    if (diff <= 0)
        return 'сегодня';
    if (diff === 1)
        return 'завтра';
    if (diff === 2)
        return 'послезавтра';
    return ruDate(target);
}
function step(title, subtitle, state, vehicle) {
    return { title, subtitle, state, icon: state === 'done' ? 'check' : state === 'now' ? vehicle : 'none' };
}
function finish(kind, title, subtitle, vehicle, steps, note = null) {
    const done = steps.filter((s) => s.state === 'done').length;
    const current = steps.findIndex((s) => s.state === 'now');
    return { kind, title, subtitle, icon: vehicle, progress: { total: steps.length, done, current }, steps, note };
}
/**
 * null — для заказов, у которых хода доставки ещё нет (ожидает оплаты).
 * Для отменённого — короткая «карточка» без шагов.
 */
function buildDelivery(o, now = new Date()) {
    if (o.status === 'cancelled') {
        return { kind: 'cancelled', title: 'Отменён', subtitle: `${ruDateTime(o.updatedAt)} · заказ отменён`, icon: 'none', progress: { total: 0, done: 0, current: -1 }, steps: [], note: null };
    }
    if (o.status === 'pending_payment' || o.status === 'awaiting_payment')
        return null;
    const city = (0, cities_1.resolveCity)(o.city) ?? (o.city ?? '').trim();
    const isAlmaty = city === delivery_1.HUB_CITY || city === '';
    const paidAt = o.paidAt ?? o.createdAt;
    const delivered = o.status === 'delivered';
    const courierStage = o.status === 'picked' || o.status === 'in_transit';
    if (isAlmaty)
        return buildExpress(o, paidAt, delivered, courierStage, now);
    return buildIntercity(o, city, paidAt, delivered, courierStage, now);
}
function buildExpress(o, paidAt, delivered, courierStage, now) {
    const promised = expressPromiseDate(paidAt);
    const promisedLabel = ruDate(promised);
    const rel = relativeDay(promised, now);
    const vehicle = 'rocket';
    const paid = step('Оплачен', ruDateTime(paidAt), 'done', vehicle);
    if (delivered) {
        const at = o.deliveredAt ?? o.updatedAt;
        return finish('express', 'Получен', `${ruDateTime(at)} · ${delivery_1.HUB_CITY}`, 'check', [
            paid,
            step('Собран на складе', '', 'done', vehicle),
            step('Курьер привёз вам', ruDateTime(at), 'done', vehicle),
            step('Заказ выдан', 'код подтверждён', 'done', vehicle),
        ]);
    }
    const l = local(now);
    const late = dayNumber(now) > dayNumber(promised) || (dayNumber(now) === dayNumber(promised) && l.h >= delivery_1.DELAY_NOTICE_HOUR);
    const note = late ? delivery_1.DELAY_NOTE : null;
    if (courierStage) {
        return finish('express', `Доставим ${rel}`, `${delivery_1.HUB_CITY} · ${promisedLabel}`, vehicle, [
            paid,
            step('Собран на складе', '', 'done', vehicle),
            step('Курьер привезёт вам', `${rel}, ${promisedLabel}`, 'now', vehicle),
            step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
        ], note);
    }
    return finish('express', `Доставим ${rel}`, `${delivery_1.HUB_CITY} · ${promisedLabel}`, vehicle, [
        paid,
        step('Собираем заказ', 'готовим к отправке', 'now', vehicle),
        step('Курьер привезёт вам', `${rel}, ${promisedLabel}`, 'todo', vehicle),
        step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
    ], note);
}
function buildIntercity(o, city, paidAt, delivered, courierStage, now) {
    const D = delivery_1.DELIVERY_DAYS[city] ?? delivery_1.DEFAULT_DELIVERY_DAYS;
    const vehicle = 'truck';
    const route = `${delivery_1.HUB_CITY} → ${city || 'ваш город'}`;
    const paid = step('Оплачен', ruDateTime(paidAt), 'done', vehicle);
    // Машина выезжает сама через AUTO_SHIP_DELAY_HOURS после оплаты; если админ нажал «Машина выехала» — берём его время.
    const autoShip = new Date(paidAt.getTime() + delivery_1.AUTO_SHIP_DELAY_HOURS * 3600 * 1000);
    const shippedAt = o.shippedAt ?? (now.getTime() >= autoShip.getTime() || delivered || courierStage ? autoShip : null);
    const packed = (state) => step('Собран на складе', shippedAt && state === 'done' ? ruDateTime(shippedAt) : '', state, vehicle);
    // Курьер уже взял заказ или заказ выдан, а «Машина прибыла» не нажали — считаем, что машина на месте.
    const arrivedAt = o.arrivedAt ?? (delivered || courierStage ? o.updatedAt : null);
    if (delivered) {
        const at = o.deliveredAt ?? o.updatedAt;
        return finish('intercity', 'Получен', `${ruDateTime(at)} · ${city}`, 'check', [
            paid, packed('done'),
            step(`В пути · ${D} дн.`, shippedAt ? `${ruDate(shippedAt)} — ${ruDate(arrivedAt ?? at)}` : '', 'done', vehicle),
            step(`Машина прибыла: ${city}`, arrivedAt ? ruDateTime(arrivedAt) : '', 'done', vehicle),
            step('Курьер привёз вам', ruDateTime(at), 'done', vehicle),
            step('Заказ выдан', 'код подтверждён', 'done', vehicle),
        ]);
    }
    if (arrivedAt) {
        const lateArrived = !courierStage && dayNumber(now) > dayNumber(arrivedAt);
        return finish('intercity', `Заказ в городе: ${city}`, courierStage ? 'Курьер уже везёт вам' : 'Курьер скоро привезёт вам', vehicle, [
            paid, packed('done'),
            step(`В пути · ${D} дн.`, shippedAt ? `${ruDate(shippedAt)} — ${ruDate(arrivedAt)}` : '', 'done', vehicle),
            step(`Машина прибыла: ${city}`, ruDateTime(arrivedAt), 'done', vehicle),
            step('Курьер привезёт вам', courierStage ? 'курьер уже в пути к вам' : 'код придёт уведомлением', 'now', vehicle),
            step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
        ], lateArrived ? delivery_1.DELAY_NOTE : null);
    }
    if (shippedAt) {
        const elapsed = Math.max(0, dayNumber(now) - dayNumber(shippedAt));
        const day = Math.min(D, elapsed + 1);
        const days = [];
        for (let d = 1; d <= D; d++) {
            const dayDate = addDays(shippedAt, d - 1);
            const state = d < day ? 'done' : d === day ? 'now' : 'todo';
            const title = d === 1 ? `День 1 · выехал из ${delivery_1.HUB_CITY}` : d === D ? `День ${D} · прибытие: ${city}` : `День ${d} · в пути`;
            days.push(step(title, state === 'todo' ? `~ ${ruDate(dayDate)}` : ruDate(dayDate), state, vehicle));
        }
        // Последний день пути: после 18:00 (и в любые дни дальше), пока код не отправлен и заказ не выдан, — «Курьер задерживается».
        const late = elapsed >= D || (elapsed === D - 1 && local(now).h >= delivery_1.DELAY_NOTICE_HOUR);
        return finish('intercity', `День ${day} из ${D} · в пути`, `${route} · прибытие ~ ${ruDate(addDays(shippedAt, D - 1))}`, vehicle, [
            paid, packed('done'), ...days,
            step('Курьер привезёт вам', 'код придёт уведомлением', 'todo', vehicle),
            step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
        ], late ? delivery_1.DELAY_NOTE : null);
    }
    return finish('intercity', 'Готовим к отправке', `${route} · в пути ~ ${D} дн.`, vehicle, [
        paid,
        step('Собираем заказ', 'готовим к отправке', 'now', vehicle),
        step(`В пути · ~ ${D} дн.`, route, 'todo', vehicle),
        step('Курьер привезёт вам', 'код придёт уведомлением', 'todo', vehicle),
        step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
    ]);
}
//# sourceMappingURL=deliveryProgress.js.map