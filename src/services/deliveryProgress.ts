import { resolveCity } from '../config/cities';
import {
  ALMATY_UTC_OFFSET_HOURS, AUTO_SHIP_DELAY_HOURS, COURIER_WORKS_ON_SUNDAY, DEFAULT_DELIVERY_DAYS, DELAY_NOTE, DELAY_NOTICE_HOUR,
  DELIVERY_DAYS, EXPRESS_CUTOFF_HOUR, HUB_CITY,
} from '../config/delivery';

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

export type DeliveryStepState = 'done' | 'now' | 'todo';
export type DeliveryIcon = 'check' | 'rocket' | 'truck' | 'none';
export type DeliveryStep = { title: string; subtitle: string; state: DeliveryStepState; icon: DeliveryIcon };
export type DeliveryInfo = {
  kind: 'express' | 'intercity' | 'cancelled';
  title: string;        // строка шторки в закрытом виде
  subtitle: string;
  icon: DeliveryIcon;   // иконка у заголовка шторки
  progress: { total: number; done: number; current: number }; // отрезки полоски; current = -1, если текущего нет
  steps: DeliveryStep[];
  note: string | null;  // маленькая подпись под шторкой («Курьер задерживается»), обычно null
};

export type DeliveryOrderInput = {
  status: string;
  city: string | null;
  createdAt: Date;
  paidAt: Date | null;
  updatedAt: Date;
  deliveredAt: Date | null;
  shippedAt: Date | null;
  arrivedAt: Date | null;
};

/** Компоненты даты по времени Алматы. */
function local(d: Date) {
  const t = new Date(d.getTime() + ALMATY_UTC_OFFSET_HOURS * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), day: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes(), dow: t.getUTCDay() };
}
/** Номер дня по Алматы (для разницы «сегодня/завтра»). */
function dayNumber(d: Date): number {
  return Math.floor((d.getTime() + ALMATY_UTC_OFFSET_HOURS * 3600 * 1000) / DAY_MS);
}
export function ruDate(d: Date): string {
  const l = local(d);
  return `${l.day} ${MONTHS_GEN[l.m]}`;
}
export function ruDateTime(d: Date): string {
  const l = local(d);
  return `${l.day} ${MONTHS_SHORT[l.m]}, ${String(l.h).padStart(2, '0')}:${String(l.min).padStart(2, '0')}`;
}
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * DAY_MS); }

/** День, к которому курьер привезёт заказ по Алматы: оплата до 18:00 → завтра, позже → послезавтра; без воскресенья, если так настроено. */
export function expressPromiseDate(paidAt: Date): Date {
  const l = local(paidAt);
  let target = addDays(paidAt, l.h >= EXPRESS_CUTOFF_HOUR ? 2 : 1);
  if (!COURIER_WORKS_ON_SUNDAY && local(target).dow === 0) target = addDays(target, 1);
  return target;
}

function relativeDay(target: Date, now: Date): string {
  const diff = dayNumber(target) - dayNumber(now);
  if (diff <= 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  return ruDate(target);
}

function step(title: string, subtitle: string, state: DeliveryStepState, vehicle: DeliveryIcon): DeliveryStep {
  return { title, subtitle, state, icon: state === 'done' ? 'check' : state === 'now' ? vehicle : 'none' };
}

function finish(kind: DeliveryInfo['kind'], title: string, subtitle: string, vehicle: DeliveryIcon, steps: DeliveryStep[], note: string | null = null): DeliveryInfo {
  const done = steps.filter((s) => s.state === 'done').length;
  const current = steps.findIndex((s) => s.state === 'now');
  return { kind, title, subtitle, icon: vehicle, progress: { total: steps.length, done, current }, steps, note };
}

/**
 * null — для заказов, у которых хода доставки ещё нет (ожидает оплаты).
 * Для отменённого — короткая «карточка» без шагов.
 */
export function buildDelivery(o: DeliveryOrderInput, now: Date = new Date()): DeliveryInfo | null {
  if (o.status === 'cancelled') {
    return { kind: 'cancelled', title: 'Отменён', subtitle: `${ruDateTime(o.updatedAt)} · заказ отменён`, icon: 'none', progress: { total: 0, done: 0, current: -1 }, steps: [], note: null };
  }
  if (o.status === 'pending_payment' || o.status === 'awaiting_payment') return null;

  const city = resolveCity(o.city) ?? (o.city ?? '').trim();
  const isAlmaty = city === HUB_CITY || city === '';
  const paidAt = o.paidAt ?? o.createdAt;
  const delivered = o.status === 'delivered';
  const courierStage = o.status === 'picked' || o.status === 'in_transit';

  if (isAlmaty) return buildExpress(o, paidAt, delivered, courierStage, now);
  return buildIntercity(o, city, paidAt, delivered, courierStage, now);
}

function buildExpress(o: DeliveryOrderInput, paidAt: Date, delivered: boolean, courierStage: boolean, now: Date): DeliveryInfo {
  const promised = expressPromiseDate(paidAt);
  const promisedLabel = ruDate(promised);
  const rel = relativeDay(promised, now);
  const vehicle: DeliveryIcon = 'rocket';
  const paid = step('Оплачен', ruDateTime(paidAt), 'done', vehicle);

  if (delivered) {
    const at = o.deliveredAt ?? o.updatedAt;
    return finish('express', 'Получен', `${ruDateTime(at)} · ${HUB_CITY}`, 'check', [
      paid,
      step('Собран на складе', '', 'done', vehicle),
      step('Курьер привёз вам', ruDateTime(at), 'done', vehicle),
      step('Заказ выдан', 'код подтверждён', 'done', vehicle),
    ]);
  }
  const l = local(now);
  const late = dayNumber(now) > dayNumber(promised) || (dayNumber(now) === dayNumber(promised) && l.h >= DELAY_NOTICE_HOUR);
  const note = late ? DELAY_NOTE : null;
  if (courierStage) {
    return finish('express', `Доставим ${rel}`, `${HUB_CITY} · ${promisedLabel}`, vehicle, [
      paid,
      step('Собран на складе', '', 'done', vehicle),
      step('Курьер привезёт вам', `${rel}, ${promisedLabel}`, 'now', vehicle),
      step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
    ], note);
  }
  return finish('express', `Доставим ${rel}`, `${HUB_CITY} · ${promisedLabel}`, vehicle, [
    paid,
    step('Собираем заказ', 'готовим к отправке', 'now', vehicle),
    step('Курьер привезёт вам', `${rel}, ${promisedLabel}`, 'todo', vehicle),
    step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
  ], note);
}

function buildIntercity(o: DeliveryOrderInput, city: string, paidAt: Date, delivered: boolean, courierStage: boolean, now: Date): DeliveryInfo {
  const D = DELIVERY_DAYS[city] ?? DEFAULT_DELIVERY_DAYS;
  const vehicle: DeliveryIcon = 'truck';
  const route = `${HUB_CITY} → ${city || 'ваш город'}`;
  const paid = step('Оплачен', ruDateTime(paidAt), 'done', vehicle);
  // Машина выезжает сама через AUTO_SHIP_DELAY_HOURS после оплаты; если админ нажал «Машина выехала» — берём его время.
  const autoShip = new Date(paidAt.getTime() + AUTO_SHIP_DELAY_HOURS * 3600 * 1000);
  const shippedAt = o.shippedAt ?? (now.getTime() >= autoShip.getTime() || delivered || courierStage ? autoShip : null);
  const packed = (state: DeliveryStepState) => step('Собран на складе', shippedAt && state === 'done' ? ruDateTime(shippedAt) : '', state, vehicle);

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
    ], lateArrived ? DELAY_NOTE : null);
  }

  if (shippedAt) {
    const elapsed = Math.max(0, dayNumber(now) - dayNumber(shippedAt));
    const day = Math.min(D, elapsed + 1);
    const days: DeliveryStep[] = [];
    for (let d = 1; d <= D; d++) {
      const dayDate = addDays(shippedAt, d - 1);
      const state: DeliveryStepState = d < day ? 'done' : d === day ? 'now' : 'todo';
      const title = d === 1 ? `День 1 · выехал из ${HUB_CITY}` : d === D ? `День ${D} · прибытие: ${city}` : `День ${d} · в пути`;
      days.push(step(title, state === 'todo' ? `~ ${ruDate(dayDate)}` : ruDate(dayDate), state, vehicle));
    }
    // Последний день пути: после 18:00 (и в любые дни дальше), пока код не отправлен и заказ не выдан, — «Курьер задерживается».
    const late = elapsed >= D || (elapsed === D - 1 && local(now).h >= DELAY_NOTICE_HOUR);
    return finish('intercity', `День ${day} из ${D} · в пути`, `${route} · прибытие ~ ${ruDate(addDays(shippedAt, D - 1))}`, vehicle, [
      paid, packed('done'), ...days,
      step('Курьер привезёт вам', 'код придёт уведомлением', 'todo', vehicle),
      step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
    ], late ? DELAY_NOTE : null);
  }

  return finish('intercity', 'Готовим к отправке', `${route} · в пути ~ ${D} дн.`, vehicle, [
    paid,
    step('Собираем заказ', 'готовим к отправке', 'now', vehicle),
    step(`В пути · ~ ${D} дн.`, route, 'todo', vehicle),
    step('Курьер привезёт вам', 'код придёт уведомлением', 'todo', vehicle),
    step('Заказ выдан', 'код придёт уведомлением', 'todo', vehicle),
  ]);
}
