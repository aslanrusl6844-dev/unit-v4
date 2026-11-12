/**
 * Подписка «Вау» (как Coupang WOW): покупатель платит за месяц и получает скидку
 * на товары с меткой «Вау» (Product.wowPercent). Скидку считает ТОЛЬКО сервер.
 *
 * Пока нет онлайн-оплаты: покупатель нажимает «Подключить» → подписка в статусе
 * pending_payment → он переводит деньги → админ жмёт «Подтвердить оплату» → active на 1 месяц.
 * Возврат: если по подписке не было покупок со скидкой — деньги возвращаются полностью,
 * если были — подписка просто дотягивает до конца месяца без продления.
 */
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { sendBroadcast } from './pushBroadcast.service';

export const WOW_MIN_PERCENT = 1;
export const WOW_MAX_PERCENT = 30;

export type WowStatus = 'pending_payment' | 'active' | 'refund_requested' | 'refunded' | 'cancelled' | 'expired';

export interface WowSettingsDto {
  enabled: boolean;
  monthlyPrice: number;
  defaultPercent: number;
  payInstructions: string | null;
}

export const WOW_DEFAULTS: WowSettingsDto = { enabled: false, monthlyPrice: 2990, defaultPercent: 5, payInstructions: null };

/** Цена со скидкой «Вау» — целые тенге, округление к ближайшему. */
export function wowPriceOf(price: number, percent: number | null | undefined): number {
  if (!percent || !Number.isFinite(price) || price <= 0) return price;
  const p = Math.min(WOW_MAX_PERCENT, Math.max(0, percent));
  return Math.round(price * (1 - p / 100));
}

/** Нормальный процент для товара: целое 1..30 или null (снять метку). */
export function normalizeWowPercent(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < WOW_MIN_PERCENT || n > WOW_MAX_PERCENT) return null;
  return n;
}

/** Месяц вперёд от даты: 12 ноя → 12 дек; 31 янв → 28/29 фев (а не 3 марта). */
export function addOneMonth(d: Date): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + 1);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

type Membership = {
  id: string; phone: string; status: string; price: number; endsAt: Date | null; startsAt: Date | null;
  paidAt: Date | null; createdAt: Date; cancelRequested: boolean; customerName: string | null;
};

/** Статус «на сейчас»: active с прошедшим endsAt — уже expired. */
export function effectiveStatus(m: Pick<Membership, 'status' | 'endsAt'>, now = new Date()): WowStatus {
  if (m.status === 'active' && m.endsAt && m.endsAt.getTime() <= now.getTime()) return 'expired';
  return m.status as WowStatus;
}

/** Даёт ли подписка скидку сейчас. Ожидающая оплаты тоже даёт: заказ и подписку админ проверяет вместе. */
export function givesDiscount(m: Pick<Membership, 'status' | 'endsAt'>, now = new Date()): boolean {
  const s = effectiveStatus(m, now);
  return s === 'active' || s === 'pending_payment';
}

export interface WowOrderItem { sku: string; name: string; price: number; quantity: number; [k: string]: unknown }

/**
 * Применяет скидку к позициям заказа. percentBySku — процент «Вау» по sku/артикулу товара.
 * Возвращает новые позиции (price уже со скидкой, basePrice — цена до скидки) и сумму скидки.
 */
export function applyWowToItems(items: WowOrderItem[], percentBySku: Map<string, number>): { items: WowOrderItem[]; discount: number } {
  let discount = 0;
  const out = items.map((i) => {
    const pct = percentBySku.get(i.sku);
    if (!pct) return i;
    const price = wowPriceOf(i.price, pct);
    if (price >= i.price) return i;
    discount += (i.price - price) * i.quantity;
    return { ...i, basePrice: i.price, price, wowPercent: pct };
  });
  return { items: out, discount: Math.round(discount) };
}

export async function getWowSettings(): Promise<WowSettingsDto> {
  try {
    const s = await prisma.wowSettings.findUnique({ where: { id: 'main' } });
    if (!s) return { ...WOW_DEFAULTS };
    return { enabled: s.enabled, monthlyPrice: s.monthlyPrice, defaultPercent: s.defaultPercent, payInstructions: s.payInstructions ?? null };
  } catch (err) {
    logger.warn({ err }, '[Wow] настройки не прочитались — подписка считается выключенной');
    return { ...WOW_DEFAULTS };
  }
}

/** Последняя подписка номера, которая сейчас даёт скидку (active или ожидает оплаты). */
export async function getCurrentMembership(phone: string): Promise<Membership | null> {
  const rows: Membership[] = await prisma.wowMembership.findMany({
    where: { phone, status: { in: ['active', 'pending_payment'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  return rows.find((m) => givesDiscount(m)) ?? null;
}

/** Сколько сэкономлено и сколько заказов со скидкой по подписке (отменённые заказы не считаем). */
export async function membershipSavings(membershipIds: string[]): Promise<Map<string, { saved: number; orders: number }>> {
  const map = new Map<string, { saved: number; orders: number }>();
  for (const id of membershipIds) map.set(id, { saved: 0, orders: 0 });
  if (!membershipIds.length) return map;
  const orders: Array<{ membershipId: string | null; wowDiscount: number }> = await prisma.shopOrder.findMany({
    where: { membershipId: { in: membershipIds }, wowDiscount: { gt: 0 }, status: { not: 'cancelled' } },
    select: { membershipId: true, wowDiscount: true },
  });
  for (const o of orders) {
    if (!o.membershipId) continue;
    const cur = map.get(o.membershipId) ?? { saved: 0, orders: 0 };
    cur.saved += o.wowDiscount;
    cur.orders += 1;
    map.set(o.membershipId, cur);
  }
  return map;
}

/** Пуш покупателю (на устройство, где он входил). Ошибки не роняют основное действие. */
export async function pushToCustomer(phone: string, title: string, body: string): Promise<void> {
  try {
    const device = await prisma.shopCustomerPushToken.findUnique({ where: { phone } });
    if (!device?.token) return;
    await sendBroadcast({ title, body, tokens: [device.token], data: { type: 'wow' } });
  } catch (err) {
    logger.warn({ err }, '[Wow] пуш покупателю не ушёл');
  }
}
