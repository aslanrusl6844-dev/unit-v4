import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { sendBroadcast } from './pushBroadcast.service';

/**
 * Напоминания как в Coupang — сервер шлёт сам, раз в сутки (Vercel Cron):
 *  - cart: товар лежит в корзине больше 2 суток (окно 48–72 ч), заказа нет → «Аслан, вы оставили …»;
 *  - view: товар смотрели сутки назад (окно 24–48 ч), не положили в корзину и не купили → «Аслан, вы смотрели …».
 * Корзина живёт в приложении; сервер видит события аналитики ShopEvent(type=cart|view, sku, phone).
 *
 * Правила (для обоих видов):
 *  - по каждому номеру берём последнее событие вида; если оно свежее начала окна — человек активен, ждём;
 *  - после события у номера был заказ (не отменённый) или оплата → не шлём; для view — ещё и «в корзину» после просмотра;
 *  - номеру за последние 24 ч уже было любое напоминание → не шлём (не больше одного пуша в сутки);
 *  - товар не найден / не в продаже / нет в наличии / нет токена пуша → не шлём;
 *  - честно: скидка — только если есть старая цена; «осталось N шт.» — только если остаток реально ≤ 3;
 *  - в пуше картинка товара; data: type=cart_reminder|view_reminder, screen=product, productId/sku/shopArticle.
 */
export type ReminderKind = 'cart' | 'view';
const KIND = {
  cart: { from: 72, to: 48, dataType: 'cart_reminder' },
  view: { from: 48, to: 24, dataType: 'view_reminder' },
} as const;
const LOW_STOCK = 3;

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

export function reminderText(name: string, pct: number | null, opts: { kind?: ReminderKind; firstName?: string | null; stock?: number | null } = {}): string {
  const n = name.trim().length > 60 ? `${name.trim().slice(0, 57)}…` : name.trim();
  const who = opts.firstName ? `${opts.firstName}, вы` : 'Вы';
  const verb = opts.kind === 'view' ? 'смотрели' : 'оставили';
  const low = opts.stock != null && opts.stock > 0 && opts.stock <= LOW_STOCK;
  const tail = low ? `Осталось ${opts.stock} шт. — успейте купить` : 'Успейте купить';
  return pct ? `${who} ${verb} ${n}. Скидка ${pct}% — ${tail.charAt(0).toLowerCase()}${tail.slice(1)}` : `${who} ${verb} ${n}. ${tail}`;
}

/** Заголовок пуша: как у Coupang — сразу выгода. */
export function reminderTitle(kind: ReminderKind, pct: number | null): string {
  if (pct) return `Скидка ${pct}% ↓ — My Market`;
  return kind === 'view' ? 'Вы смотрели — My Market' : 'Товар ждёт в корзине — My Market';
}

/** Имя из последнего заказа номера («Аслан Тушкеев» → «Аслан»); нет заказов — без имени. */
export function firstNameOf(customerName: unknown): string | null {
  const w = String(customerName ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}-]{2,20}$/u.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : null;
}

function phoneVariants(ph: string): string[] {
  const d = ph.slice(1);
  return [ph, `+${ph}`, `8${d}`, d, `+7 ${d}`];
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

/** Оба вида за один запуск: сначала корзина, потом просмотры (один пуш в сутки на номер). */
export async function runCartReminders(now = new Date()): Promise<CartReminderResult> {
  const a = await runReminderKind('cart', now);
  const b = await runReminderKind('view', now);
  return { candidates: a.candidates + b.candidates, sent: a.sent + b.sent, skipped: a.skipped + b.skipped, failed: a.failed + b.failed };
}

export async function runReminderKind(kind: ReminderKind, now = new Date()): Promise<CartReminderResult> {
  const cfg = KIND[kind];
  const res: CartReminderResult = { candidates: 0, sent: 0, skipped: 0, failed: 0 };
  const windowStart = new Date(now.getTime() - cfg.from * HOUR);
  const cutoff = new Date(now.getTime() - cfg.to * HOUR);
  const dayAgo = new Date(now.getTime() - 24 * HOUR);

  const events: any[] = await prisma.shopEvent.findMany({
    where: { type: kind, createdAt: { gte: windowStart }, phone: { not: null }, sku: { not: null } },
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
  // Для просмотров «дальше по воронке» — ещё и корзина: ей займётся напоминание о корзине.
  const doneTypes: Array<'order' | 'paid' | 'cart'> = kind === 'view' ? ['order', 'paid', 'cart'] : ['order', 'paid'];
  const doneEvents: any[] = await prisma.shopEvent.findMany({ where: { type: { in: doneTypes }, createdAt: { gte: windowStart }, phone: { not: null } } });
  for (const o of doneEvents) {
    const ph = normPhone(o.phone);
    if (ph) orderTimes.set(ph, [...(orderTimes.get(ph) ?? []), new Date(o.createdAt).getTime()]);
  }
  const recent: any[] = await prisma.cartReminder.findMany({ where: { sentAt: { gte: dayAgo } } });
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
        await prisma.cartReminder.create({ data: { eventId: ev.id, phone, sku: String(ev.sku), kind } });
        recentPhones.add(phone);
      } catch {
        res.skipped++; return; // уже напоминали (уникальный eventId)
      }
      const lastOrder: any[] = await prisma.shopOrder.findMany({ where: { phone: { in: phoneVariants(phone) } }, orderBy: { createdAt: 'desc' }, take: 1 });
      const firstName = firstNameOf(lastOrder[0]?.customerName);
      const pct = discountPercent(product.shopPrice, product.shopOldPrice);
      const r = await sendBroadcast({
        title: reminderTitle(kind, pct),
        body: reminderText(product.name, pct, { kind, firstName, stock: product.shopStock }),
        imageUrl: firstImage(product),
        tokens: [rec.token],
        data: { type: cfg.dataType, screen: 'product', productId: String(product.id), sku: String(product.sku), shopArticle: String(product.shopArticle ?? '') },
      });
      if (r.sent > 0) res.sent++; else { res.failed++; logger.error({ phone, failed: r.failed, fcmError: r.fcmError }, '[CartReminder] Пуш не принят'); }
    } catch (err: any) {
      res.failed++;
      logger.error({ err: String(err?.message ?? err) }, '[CartReminder] Ошибка по номеру');
    }
  };
  for (let i = 0; i < eligible.length; i += PARALLEL) await Promise.all(eligible.slice(i, i + PARALLEL).map(work));
  logger.info(res, `[CartReminder] Проверка завершена (${kind})`);
  return res;
}


/**
 * Пробный пуш из админки (Рассылка → «Пример напоминания»): последний просмотренный / положенный в корзину
 * товар номера, без окон по времени и без записи в журнал — чтобы увидеть, как выглядит настоящее напоминание.
 */
export async function sendTestReminder(kind: ReminderKind, rawPhone: string): Promise<{ ok: boolean; message: string }> {
  const phone = normPhone(rawPhone);
  if (!phone) return { ok: false, message: 'Неверный номер' };
  const rec = await prisma.shopCustomerPushToken.findUnique({ where: { phone } });
  if (!rec?.token) return { ok: false, message: 'У номера нет разрешения на пуши (приложение не входило с этим номером)' };
  const events: any[] = await prisma.shopEvent.findMany({
    where: { type: kind, phone: { in: phoneVariants(phone) }, sku: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  for (const ev of events) {
    const products: any[] = await prisma.product.findMany({ where: { OR: [{ sku: ev.sku }, { shopArticle: ev.sku }] }, take: 1 });
    const product = products[0];
    if (!product || !product.shopActive || product.shopArchived || product.shopPrice == null) continue;
    const lastOrder: any[] = await prisma.shopOrder.findMany({ where: { phone: { in: phoneVariants(phone) } }, orderBy: { createdAt: 'desc' }, take: 1 });
    const pct = discountPercent(product.shopPrice, product.shopOldPrice);
    const r = await sendBroadcast({
      title: reminderTitle(kind, pct),
      body: reminderText(product.name, pct, { kind, firstName: firstNameOf(lastOrder[0]?.customerName), stock: product.shopStock }),
      imageUrl: firstImage(product),
      tokens: [rec.token],
      data: { type: KIND[kind].dataType, screen: 'product', productId: String(product.id), sku: String(product.sku), shopArticle: String(product.shopArticle ?? '') },
    });
    return r.sent > 0
      ? { ok: true, message: `Отправлено: ${product.name}` }
      : { ok: false, message: `Пуш не принят: ${r.fcmError ?? 'ошибка доставки'}` };
  }
  return { ok: false, message: kind === 'view' ? 'Этот номер ещё не смотрел товары в продаже' : 'У этого номера нет товаров в корзине' };
}
