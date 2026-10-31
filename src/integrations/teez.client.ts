import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { NormalizedOrder } from '../types';

/**
 * Клиент Teez Seller API (маркетплейс Teez / Freedom Market, teez.kz).
 * Документация: https://api-docs.teez.kz/
 *
 * Что умеет API (и что НЕТ — важно не обещать лишнего):
 * - заказы (POST /api/seller/v1/orders/list): продажи, возвраты, комиссия и
 *   сумма к выплате по каждой строке;
 * - товары (POST /api/seller/v1/products/list и /products/details): статус,
 *   остаток, число продаж, цена;
 * - справочники (категории, бренды, характеристики).
 * Поисковой аналитики, показов и рекламы в API Teez НЕТ.
 *
 * Авторизация: POST /api/v1/auth/token с { clientId, clientSecret } → JWT на
 * 1 час (Bearer). Лимиты: токен — 30 запросов в минуту, остальное — 100 в
 * минуту на один clientId.
 *
 * Ключи берутся из формы «Настройки» (таблица TeezStore), как у остальных
 * площадок.
 */

const MAX_PAGES_SAFETY = 100;
const PAGE_SIZE = 100;
const PACING_DELAY_MS = 650; // 100 запросов/мин = 1 запрос на 0.6 с
const MAX_429_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_SAFETY_MARGIN_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Строка заказа из POST /api/seller/v1/orders/list (1 строка = 1 товарная позиция). */
export interface TeezOrderRow {
  orderId?: number;
  orderGuid?: string;
  orderNumber?: string | number;
  createdDate?: string;
  receivedDate?: string | null;
  statusKey?: string; // pending | received | canceled
  statusLabel?: string;
  barcode?: string | null;
  productName?: string | null;
  quantity?: number;
  quantityReturned?: number;
  commissionPercent?: number;
  price?: number; // цена за единицу
  originalPrice?: number | null;
  commissionAmount?: number; // за единицу
  payoutAmount?: number; // за единицу
  totalPrice?: number;
  totalCommissionAmount?: number;
  totalPayoutAmount?: number;
}

export interface TeezProductRow {
  productId: number;
  productName?: { rus?: string; kaz?: string } | null;
  categoryName?: { rus?: string; kaz?: string } | null;
  categoryId?: number;
  productStatus?: string;
  moderationStatus?: string;
  totalWmsQuantity?: number;
  salesCount?: number;
  photo?: { url?: string } | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Статус Teez → наши статусы (те же слова, что у Kaspi, чтобы работали подписи и фильтры в панели). */
export function mapTeezStatus(statusKey: string | undefined, netQuantity: number): string {
  const key = String(statusKey ?? '').toLowerCase();
  if (key === 'canceled' || key === 'cancelled') return 'CANCELLED';
  // Всё возвращено — это не продажа (NON_SALE_STATUSES исключает RETURNED из выручки).
  if (netQuantity <= 0) return 'RETURNED';
  if (key === 'received') return 'COMPLETED';
  return 'NEW'; // pending («В обработке») и любые неизвестные
}

/**
 * Одна строка заказа Teez → нормализованный заказ.
 * Деньги берём ровно те, что вернул Teez (комиссия и выплата посчитаны
 * площадкой), ничего не выдумываем. При частичном возврате считаем только
 * оставшиеся штуки.
 */
export function mapTeezOrder(row: TeezOrderRow): NormalizedOrder | null {
  const externalId = String(row.orderGuid || row.orderNumber || row.orderId || '').trim();
  if (!externalId || !row.createdDate) return null;

  const quantity = Math.max(1, Math.round(num(row.quantity)) || 1);
  const returned = Math.min(quantity, Math.max(0, Math.round(num(row.quantityReturned))));
  const netQuantity = quantity - returned;

  const unitPrice = num(row.price) || (quantity > 0 ? num(row.totalPrice) / quantity : 0);
  const unitCommission =
    row.commissionAmount != null
      ? num(row.commissionAmount)
      : quantity > 0
        ? num(row.totalCommissionAmount) / quantity
        : 0;

  // Для отменённого/полностью возвращённого заказа деньги не считаем продажей,
  // но саму строку сохраняем (она видна в «Заказах» зачёркнутой).
  const effectiveQty = netQuantity > 0 ? netQuantity : quantity;
  const status = mapTeezStatus(row.statusKey, netQuantity);

  return {
    externalId,
    marketplace: 'TEEZ',
    status,
    orderDate: new Date(row.createdDate),
    deliveryType: undefined,
    city: undefined,
    totalRevenue: round2(unitPrice * effectiveQty),
    marketplaceCommission: round2(unitCommission * effectiveQty),
    logisticsCost: 0,
    acquiringCost: 0,
    otherFees: 0,
    items: [
      {
        externalSku: String(row.barcode || row.orderNumber || externalId),
        name: String(row.productName || `Товар Teez ${row.barcode ?? ''}`).trim(),
        quantity: effectiveQty,
        price: unitPrice,
      },
    ],
    raw: row,
  };
}

interface TeezCredentials {
  clientId: string;
  clientSecret: string;
}

class TeezClient {
  private token: { value: string; expiresAt: number; clientId: string } | null = null;

  private async getCredentials(): Promise<TeezCredentials | null> {
    const store = await prisma.teezStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (store?.clientId && store.clientSecret) return { clientId: store.clientId, clientSecret: store.clientSecret };
    return null;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getCredentials()) != null;
  }

  /** Сбросить кэш токена (после смены ключей в «Настройках»). */
  resetToken(): void {
    this.token = null;
  }

  /** Токен авторизации; кэшируется до истечения (живёт ~1 час). */
  async getToken(creds?: TeezCredentials): Promise<string> {
    const credentials = creds ?? (await this.getCredentials());
    if (!credentials) throw new Error('Teez: ключи не заданы — добавьте Client ID и ключ в разделе «Настройки».');

    if (
      this.token &&
      this.token.clientId === credentials.clientId &&
      this.token.expiresAt - TOKEN_SAFETY_MARGIN_MS > Date.now()
    ) {
      return this.token.value;
    }

    try {
      const res = await axios.post(
        `${env.teez.baseUrl}/api/v1/auth/token`,
        { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
        { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } },
      );
      const accessToken = String(res.data?.accessToken ?? '');
      if (!accessToken) throw new Error('Teez не вернул токен авторизации');
      const expiresInSec = num(res.data?.expiresIn) || 3600;
      this.token = { value: accessToken, expiresAt: Date.now() + expiresInSec * 1000, clientId: credentials.clientId };
      return accessToken;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 401 || status === 403) {
        throw new Error('Teez отклонил Client ID или ключ — проверьте, что ключ создан в Настройки → Ключи API и скопирован целиком.');
      }
      if (status === 429) throw new Error('Teez временно ограничил запросы токена (не более 30 в минуту), подождите минуту.');
      throw new Error(`Не удалось получить токен Teez: ${String(err?.response?.data?.message ?? err?.message ?? err)}`);
    }
  }

  /** Проверка ключей: удалось ли получить токен. Не бросает исключение. */
  async testConnection(creds?: TeezCredentials): Promise<{ ok: boolean; error?: string }> {
    try {
      this.token = null;
      await this.getToken(creds);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  private async post<T>(path: string, body: unknown, context: string): Promise<T> {
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      const token = await this.getToken();
      try {
        const res = await axios.post(`${env.teez.baseUrl}${path}`, body, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        return res.data as T;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 401 && attempt === 0) {
          // Токен мог истечь раньше срока — берём новый и повторяем один раз.
          this.token = null;
          continue;
        }
        if (status === 429) {
          if (attempt >= MAX_429_RETRIES) {
            throw new Error('Teez временно ограничил запросы (лимит 100 в минуту), подождите минуту и повторите синхронизацию.');
          }
          const waitSec = Number(err.response?.headers?.['retry-after']) > 0 ? Number(err.response.headers['retry-after']) : 20;
          logger.warn(`[Teez] 429 (${context}) — жду ${waitSec}с, попытка ${attempt + 1}/${MAX_429_RETRIES}`);
          await sleep(waitSec * 1000);
          continue;
        }
        const details = err?.response?.data?.errorMessage ?? err?.response?.data?.message ?? err?.message ?? err;
        const wrapped: any = new Error(`Teez (${context}): ${String(details)}`);
        wrapped.status = status;
        throw wrapped;
      }
    }
    throw new Error(`Teez (${context}): не удалось выполнить запрос`);
  }

  /** Одна страница заказов; при отказе формата сортировки пробуем запасные варианты. */
  private async fetchOrdersPage(
    pageNumber: number,
    sortVariant: number,
  ): Promise<{ orders: TeezOrderRow[]; totalPages: number }> {
    const sortings: Array<Record<string, string>> = [
      { sortBy: 'createdDate', sortDirection: 'Desc' },
      { sortBy: 'CreatedDate', sortDirection: 'desc' },
      {}, // без сортировки — читаем все страницы
    ];
    const body = { pageNumber, pageSize: PAGE_SIZE, ...sortings[sortVariant] };
    const data = await this.post<{ orders?: TeezOrderRow[]; totalPages?: number }>('/api/seller/v1/orders/list', body, 'заказы');
    return { orders: data.orders ?? [], totalPages: num(data.totalPages) };
  }

  /**
   * Заказы за период. У API нет фильтра по датам — идём по страницам от новых
   * к старым и останавливаемся, когда страница целиком старше dateFrom.
   * Если сортировку сервер не принял, читаем всё и фильтруем у себя.
   */
  async fetchOrders(opts: { dateFrom: Date; dateTo: Date }): Promise<NormalizedOrder[]> {
    const result: NormalizedOrder[] = [];
    let sortVariant = 0;
    let page = 1;

    while (page <= MAX_PAGES_SAFETY) {
      let data: { orders: TeezOrderRow[]; totalPages: number };
      try {
        data = await this.fetchOrdersPage(page, sortVariant);
      } catch (err: any) {
        // 400 на первой странице — вероятно, формат сортировки; пробуем следующий вариант.
        if (err?.status === 400 && page === 1 && sortVariant < 2) {
          sortVariant += 1;
          logger.warn(`[Teez] Сервер не принял сортировку заказов, пробую вариант ${sortVariant}`);
          continue;
        }
        throw err;
      }

      let oldestOnPage = Infinity;
      for (const row of data.orders) {
        const created = row.createdDate ? new Date(row.createdDate).getTime() : NaN;
        if (Number.isFinite(created)) oldestOnPage = Math.min(oldestOnPage, created);
        if (!Number.isFinite(created)) continue;
        if (created < opts.dateFrom.getTime() || created > opts.dateTo.getTime()) continue;
        const mapped = mapTeezOrder(row);
        if (mapped) result.push(mapped);
      }

      const lastPage = data.orders.length === 0 || (data.totalPages > 0 && page >= data.totalPages);
      const passedRange = sortVariant < 2 && oldestOnPage < opts.dateFrom.getTime();
      if (lastPage || passedRange) break;

      page += 1;
      await sleep(PACING_DELAY_MS);
    }

    return result;
  }

  /** Список товаров магазина (статус, остаток, число продаж) — постранично, до конца. */
  async fetchProducts(): Promise<TeezProductRow[]> {
    const products: TeezProductRow[] = [];
    for (let page = 1; page <= MAX_PAGES_SAFETY; page++) {
      const data = await this.post<{ products?: TeezProductRow[]; totalPages?: number }>(
        '/api/seller/v1/products/list',
        { pageNumber: page, pageSize: PAGE_SIZE, sortBy: 'Id', sortDirection: 'Asc' },
        'товары',
      );
      products.push(...(data.products ?? []));
      if (!data.products?.length || page >= num(data.totalPages)) break;
      await sleep(PACING_DELAY_MS);
    }
    return products;
  }
}

export const teezClient = new TeezClient();
