import { randomUUID } from 'crypto';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { deliveryFeeOfOrder } from '../config/shopDelivery';

/**
 * Онлайн-касса re:Kassa (Partner API): фискальные чеки по заказам My Market.
 * Ключи — только в Vercel: REKASSA_API_KEY, REKASSA_KASSA_NUMBER (ЗНМ), REKASSA_KASSA_PASSWORD.
 * REKASSA_BASE_URL — по умолчанию тестовый контур; для боевой кассы — https://api.rekassa.kz.
 * REKASSA_AUTO=on — пробивать чек сам при оплате заказа (пока оплаты картой нет — выключено).
 */
const TEST_BASE = 'https://app-test.rekassa.kz/partner';

export function rekassaConfigured(): boolean {
  return !!(process.env.REKASSA_API_KEY && process.env.REKASSA_KASSA_NUMBER && process.env.REKASSA_KASSA_PASSWORD);
}
export function rekassaAuto(): boolean {
  return rekassaConfigured() && (process.env.REKASSA_AUTO ?? '').trim().toLowerCase() === 'on';
}
function baseUrl(): string {
  return (process.env.REKASSA_BASE_URL || TEST_BASE).replace(/\/+$/, '');
}
export function rekassaIsTest(): boolean {
  return baseUrl().includes('app-test');
}

/**
 * Ссылка на чек в ОФД. Касса ещё отдаёт старый адрес *.4ek.kz — re:Kassa просит использовать только
 * ofd-test.rekassa.kz (тест) и ofd.rekassa.kz (бой), страница чека — /portal/.
 */
export function ofdReceiptUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname === 'test.4ek.kz') u.hostname = 'ofd-test.rekassa.kz';
    else if (u.hostname === '4ek.kz' || u.hostname === 'www.4ek.kz') u.hostname = 'ofd.rekassa.kz';
    if (/^ofd(-test)?\.rekassa\.kz$/.test(u.hostname) && (u.pathname === '/' || u.pathname === '')) u.pathname = '/portal/';
    return u.toString();
  } catch {
    return null;
  }
}

export class RekassaError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); }
}

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...a) => fetch(...a);
/** Для тестов: подменить сеть. */
export function setRekassaFetch(f: FetchFn | null) { fetchImpl = f ?? ((...a) => fetch(...a)); session = null; }

let session: { token: string; crId: number; pin: string; until: number } | null = null;

async function login(): Promise<{ token: string; crId: number; pin: string }> {
  if (session && session.until > Date.now()) return session;
  const url = `${baseUrl()}/api/auth/login?apiKey=${encodeURIComponent(process.env.REKASSA_API_KEY ?? '')}&format=json`;
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: process.env.REKASSA_KASSA_NUMBER, password: process.env.REKASSA_KASSA_PASSWORD }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok || !body?.token) throw new RekassaError(body?.code ?? 'LOGIN_FAILED', body?.message ?? `Вход в кассу не удался (${r.status})`, r.status);
  // Токен живёт недолго — держим 10 минут, потом входим заново.
  session = { token: body.token, crId: Number(body.id), pin: String(body.cashRegisterPassword ?? ''), until: Date.now() + 10 * 60_000 };
  return session;
}

async function call(path: (crId: number) => string, init: { method: string; body?: unknown; headers?: Record<string, string> }, retried = false): Promise<any> {
  const s = await login();
  const r = await fetchImpl(`${baseUrl()}${path(s.crId)}`, {
    method: init.method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body: any = await r.json().catch(() => ({}));
  if (r.status === 401 && !retried) { session = null; return call(path, init, true); }
  if (!r.ok) throw new RekassaError(body?.code ?? `HTTP_${r.status}`, body?.message ?? `Ошибка кассы (${r.status})`, r.status);
  return body;
}

/** Деньги в формате кассы: тенге строкой + тиыны. */
function money(tenge: number) {
  const tiyn = Math.round(tenge * 100);
  return { bills: String(Math.trunc(tiyn / 100)), coins: tiyn % 100 };
}

function protoNow() {
  const d = new Date(Date.now() + 5 * 3600_000); // время кассы — Алматы (UTC+5); касса всё равно перезапишет
  return {
    date: { year: String(d.getUTCFullYear()), month: String(d.getUTCMonth() + 1), day: String(d.getUTCDate()) },
    time: { hour: String(d.getUTCHours()), minute: String(d.getUTCMinutes()), second: String(d.getUTCSeconds()) },
  };
}

type OrderItem = { sku?: string; name?: string; price?: number; quantity?: number };

/** Тело чека по заказу: товары + доставка отдельной строкой, оплата картой. */
export function ticketFor(order: { total: number; items: string }, operation: 'sell' | 'return') {
  const items: OrderItem[] = JSON.parse(order.items || '[]');
  const lines = items
    .filter((i) => (Number(i.quantity) || 0) > 0)
    .map((i) => ({ name: String(i.name || i.sku || 'Товар').slice(0, 120), price: Number(i.price) || 0, qty: Number(i.quantity) || 0 }));
  const delivery = deliveryFeeOfOrder(order.total, items);
  if (delivery > 0) lines.push({ name: 'Доставка', price: delivery, qty: 1 });
  let totalTiyn = 0;
  const ticketItems = lines.map((l) => {
    const sumTiyn = Math.round(l.price * 100) * l.qty;
    totalTiyn += sumTiyn;
    return {
      type: 'ITEM_TYPE_COMMODITY',
      commodity: {
        name: l.name,
        sectionCode: '1',
        quantity: l.qty * 1000,
        price: money(l.price),
        sum: money(sumTiyn / 100),
        measureUnitCode: '796',
        auxiliary: [{ key: 'UNIT_TYPE', value: 'PIECE' }],
      },
    };
  });
  const total = money(totalTiyn / 100);
  return {
    total: totalTiyn / 100,
    body: {
      operation: operation === 'sell' ? 'OPERATION_SELL' : 'OPERATION_SELL_RETURN',
      dateTime: protoNow(),
      domain: { type: 'DOMAIN_TRADING' },
      items: ticketItems,
      payments: [{ type: 'PAYMENT_CARD', sum: total }],
      amounts: { total, taken: total, change: { bills: '0', coins: 0 } },
    },
  };
}

/** Пуш покупателю: чек по заказу готов (тап — «Мои заказы»). Номер в базе токенов — как в заказе или нормализованный. */
async function notifyReceipt(phone: string, number: string, operation: 'sell' | 'return', emailed: boolean) {
  // Токен пуша может быть записан как «77771234567», «+77771234567» или «87771234567» — ищем все варианты.
  const d = String(phone ?? '').replace(/\D/g, '');
  const ten = d.length === 11 ? d.slice(1) : d.length === 10 ? d : '';
  const variants = ten ? [phone, `7${ten}`, `+7${ten}`, `8${ten}`] : [phone];
  const device = await prisma.shopCustomerPushToken.findFirst({ where: { phone: { in: variants } } });
  if (!device?.token) return;
  const { sendBroadcast } = await import('./pushBroadcast.service');
  await sendBroadcast({
    title: operation === 'sell' ? `🧾 Чек по заказу ${number}` : `🧾 Чек возврата по заказу ${number}`,
    body: emailed ? 'Чек в «Моих заказах» и на вашей почте' : 'Откройте «Мои заказы» → «Чек»',
    tokens: [device.token],
    data: { type: 'order', orderNumber: number },
  });
}

/**
 * Пробить чек по заказу (продажа или возврат). Один чек на заказ и операцию:
 * повторный вызов после ошибки идёт с тем же X-Request-ID — касса не задвоит чек.
 */
export async function fiscalizeOrder(orderId: string, operation: 'sell' | 'return'): Promise<any> {
  if (!rekassaConfigured()) throw new RekassaError('NOT_CONFIGURED', 'Касса не подключена: нет ключей re:Kassa в Vercel');
  const order = await prisma.shopOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new RekassaError('ORDER_NOT_FOUND', 'Заказ не найден');
  const existing = await prisma.fiscalReceipt.findUnique({ where: { orderId_operation: { orderId, operation } } });
  if (existing && (existing.status === 'ok' || existing.status === 'offline')) return existing;
  if (operation === 'return') {
    const sold = await prisma.fiscalReceipt.findUnique({ where: { orderId_operation: { orderId, operation: 'sell' } } });
    if (!sold || (sold.status !== 'ok' && sold.status !== 'offline')) throw new RekassaError('NO_SALE_RECEIPT', 'Чека продажи по заказу нет — возвращать нечего');
  }
  const { body, total } = ticketFor(order, operation);
  if (total <= 0) throw new RekassaError('EMPTY_ORDER', 'В заказе нет товаров для чека');
  const rec = existing
    ?? await prisma.fiscalReceipt.create({ data: { orderId, operation, requestId: randomUUID(), total } });
  try {
    const t = await call((cr) => `/api/crs/${cr}/tickets`, { method: 'POST', body, headers: { 'X-Request-ID': rec.requestId } });
    const done = await prisma.fiscalReceipt.update({
      where: { id: rec.id },
      data: {
        status: t.offline ? 'offline' : 'ok', ticketId: Number(t.id) || null,
        ticketNumber: t.ticketNumber ?? t.offlineTicketNumber ?? null, qrUrl: ofdReceiptUrl(t.qrCode), total, error: null,
      },
    });
    // Выдача чека: на e-mail покупателя (re:Kassa шлёт письмо сама), иначе — отметка «выдан ссылкой».
    // WhatsApp через API re:Kassa не поддерживает. Ссылка на чек всегда есть в «Моих заказах».
    const email = (order as any).email as string | null;
    await call((cr) => `/api/crs/${cr}/tickets/${done.ticketId}/receipts`, {
      method: 'POST', body: email ? { type: 'EMAIL', receiver: { email } } : { type: 'DOWNLOAD' },
    }).catch((err) => logger.warn({ err, orderId }, '[re:Kassa] выдача чека не прошла'));
    // Пуш от My Market: «Чек готов» — открывает «Мои заказы».
    await notifyReceipt(order.phone, order.number, operation, !!email).catch(() => undefined);
    return done;
  } catch (err: any) {
    const msg = err instanceof RekassaError ? `${err.code}: ${err.message}` : String(err?.message ?? err);
    await prisma.fiscalReceipt.update({ where: { id: rec.id }, data: { status: 'error', error: msg.slice(0, 500) } });
    logger.error({ err, orderId, operation }, '[re:Kassa] чек не пробит');
    throw err;
  }
}

/** Состояние кассы для админки: подключена ли, смена, режим ОФД. */
export async function rekassaStatus() {
  if (!rekassaConfigured()) return { configured: false, test: rekassaIsTest(), auto: false };
  try {
    const cr = await call((id) => `/api/crs/${id}`, { method: 'GET' });
    return {
      configured: true, test: rekassaIsTest(), auto: rekassaAuto(), ok: true,
      name: cr.name, serialNumber: cr.serialNumber, status: cr.status, fdoMode: cr.fdoMode,
      shiftOpen: !!cr.shiftOpen, shiftNumber: cr.shiftNumber, shiftExpireTime: cr.shiftExpireTime ?? null,
    };
  } catch (err: any) {
    return { configured: true, test: rekassaIsTest(), auto: rekassaAuto(), ok: false, error: `${err.code ?? ''} ${err.message ?? err}`.trim() };
  }
}

/** Закрыть открытую смену (Z-отчёт). Вызывается раз в сутки из крона — смена не должна жить больше 24 ч. */
export async function closeRekassaShift(): Promise<{ closed: boolean; shiftNumber?: number; reason?: string }> {
  if (!rekassaConfigured()) return { closed: false, reason: 'not_configured' };
  const s = await login();
  const cr = await call((id) => `/api/crs/${id}`, { method: 'GET' });
  if (!cr.shiftOpen) return { closed: false, reason: 'no_open_shift' };
  const r = await fetchImpl(`${baseUrl()}/api/crs/${s.crId}/shifts/${cr.shiftNumber}/close`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${s.token}`, 'X-Request-ID': randomUUID(),
      // Пароль кассы (не пароль интеграции) — касса отдаёт его при входе.
      'cash-register-password': s.pin || process.env.REKASSA_CASHIER_PIN || '0000',
    },
  });
  if (!r.ok) {
    const b: any = await r.json().catch(() => ({}));
    throw new RekassaError(b?.code ?? `HTTP_${r.status}`, b?.message ?? 'Смена не закрылась', r.status);
  }
  return { closed: true, shiftNumber: cr.shiftNumber };
}
