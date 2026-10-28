import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { sendBroadcast } from './pushBroadcast.service';

/**
 * Напоминание о корзине (как в Coupang): товар лежал в корзине больше 24 часов, заказ не оформлен →
 * пуш владельцу корзины. Корзина живёт в приложении; на сервер приходят события аналитики
 * ShopEvent(type=cart, sku, phone) — по ним и работаем (удаление из корзины сервер не видит).
 *
 * Правила:
 *  - берём события «в корзину» с телефоном за окно [now-48ч, now-24ч]; по каждому номеру — последнее;
 *    если последнее событие свежее 24 ч (человек сейчас активен) — ждём;
 *  - после этого события у номера был заказ (не отменённый) или оплата → не шлём;
 *  - номеру уже слали напоминание за последние 24 ч, или это событие уже напоминали → не шлём;
 *  - товар не найден / не в продаже / нет токена пуша → не шлём;
 *  - текст: «Вы оставили [название]. Скидка [X]% — успейте купить» (X из старой цены; нет скидки — без неё);
 *  - в пуше картинка товара; data: type=cart_reminder, screen=product, productId/sku/shopArticle для открытия товара.
 */
const HOUR = 3600_000;
const MAX_PER_RUN = 200;
const PARALLEL = 10;

const normPhone = (raw: unknown): string | null => {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') return '7' + d.slice(1);
  if (d.length === 11 && d[0] === '7') return d;
  if (d.length === 10) return '7' + d;
  return null;
};

export function discountPercent(price: unknown, oldPrice: unknown): number | null {
  const p = Number(price), o = Number(oldPrice);
  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 0 || p < 0 || o <= p) return null;
  const pct = Math.round(((o - p) / o) * 100);
  return pct >= 1 ? pct : null;
}

export function reminderText(name: string, pct: number | null): string {
  const n = name.trim().length > 60 ? `${name.trim().slice(0, 57)}…` : name.trim();
  return pct ? `Вы оставили ${n}. Скидка ${pct}% — успейте купить` : `Вы оставили ${n}. Успейте купить`;
}

function firstImage(p: any): string | null {
  try {
    const arr = p.images ? JSON.parse(p.images) : [];
    const u = Array.isArray(arr) ? arr.find((x: unknown) => typeof x === 'string' && /^https:\/\/\S+$/i.test(x)) : null;
    return u ?? null;
  } catch {
    return null;
  }
}

export interface CartReminderResult { candidates: number; sent: number; skipped: number; failed: number }

export async function runCartReminders(now = new Date()): Promise<CartReminderResult> {
  const res: CartReminderResult = { candidates: 0, sent: 0, skipped: 0, failed: 0 };
  const windowStart = new Date(now.getTime() - 48 * HOUR);
  const cutoff = new Date(now.getTime() - 24 * HOUR);

  const events: any[] = await prisma.shopEvent.findMany({
    where: { type: 'cart', createdAt: { gte: windowStart }, phone: { not: null }, sku: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  // последнее событие по номеру
  const latest = new Map<string, any>();
  for (const e of events) {
    const ph = normPhone(e.phone);
    if (ph && !latest.has(ph)) latest.set(ph, e);
  }
  const eligible = [...latest.entries()].filter(([, e]) => new Date(e.createdAt) <= cutoff).slice(0, MAX_PER_RUN);
  res.candidates = eligible.length;
  if (!eligible.length) return res;

  // заказы/оплаты после корзины
  const orders: any[] = await prisma.shopOrder.findMany({ where: { createdAt: { gte: windowStart } } });
  const orderTimes = new Map<string, number[]>();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const ph = normPhone(o.phone);
    if (ph) orderTimes.set(ph, [...(orderTimes.get(ph) ?? []), new Date(o.createdAt).getTime()]);
  }
  const doneEvents: any[] = await prisma.shopEvent.findMany({ where: { type: { in: ['order', 'paid'] }, createdAt: { gte: windowStart }, phone: { not: null } } });
  for (const o of doneEvents) {
    const ph = normPhone(o.phone);
    if (ph) orderTimes.set(ph, [...(orderTimes.get(ph) ?? []), new Date(o.createdAt).getTime()]);
  }
  const recent: any[] = await prisma.cartReminder.findMany({ where: { sentAt: { gte: cutoff } } });
  const recentPhones = new Set(recent.map((r) => r.phone));

  const work = async ([phone, ev]: [string, any]) => {
    try {
      if ((orderTimes.get(phone) ?? []).some((t) => t >= new Date(ev.createdAt).getTime())) { res.skipped++; return; }
      if (recentPhones.has(phone)) { res.skipped++; return; }
      const products: any[] = await prisma.product.findMany({ where: { OR: [{ sku: ev.sku }, { shopArticle: ev.sku }] }, take: 1 });
      const product = products[0];
      if (!product || !product.shopActive || product.shopArchived || product.shopPrice == null || (product.shopStock != null && product.shopStock <= 0)) { res.skipped++; return; }
      const rec = await prisma.shopCustomerPushToken.findUnique({ where: { phone } });
      if (!rec?.token) { res.skipped++; return; }
      // «Занимаем» событие до отправки: параллельный запуск не пришлёт второй раз.
      try {
        await prisma.cartReminder.create({ data: { eventId: ev.id, phone, sku: String(ev.sku) } });
      } catch {
        res.skipped++; return; // уже напоминали (уникальный eventId)
      }
      const r = await sendBroadcast({
        title: 'My Market',
        body: reminderText(product.name, discountPercent(product.shopPrice, product.shopOldPrice)),
        imageUrl: firstImage(product),
        tokens: [rec.token],
        data: { type: 'cart_reminder', screen: 'product', productId: String(product.id), sku: String(product.sku), shopArticle: String(product.shopArticle ?? '') },
      });
      if (r.sent > 0) res.sent++; else { res.failed++; logger.error({ phone, failed: r.failed, fcmError: r.fcmError }, '[CartReminder] Пуш не принят'); }
    } catch (err: any) {
      res.failed++;
      logger.error({ err: String(err?.message ?? err) }, '[CartReminder] Ошибка по номеру');
    }
  };
  for (let i = 0; i < eligible.length; i += PARALLEL) await Promise.all(eligible.slice(i, i + PARALLEL).map(work));
  logger.info(res, '[CartReminder] Проверка завершена');
  return res;
}
