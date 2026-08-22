import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { NormalizedOrder, NormalizedOrderItem } from '../types';

/**
 * Клиент для Ozon Seller API.
 * Документация: https://docs.ozon.ru/api/seller
 *
 * Заказы берём через POST /v3/posting/fbs/list (+ /v2/posting/fbo/list для FBO),
 * а реальные удержания (комиссия, логистика, эквайринг) — через
 * POST /v3/finance/transaction/list, т.к. в самом заказе комиссия не всегда
 * отражена финально (может меняться после начисления).
 *
 * Client-Id/Api-Key берутся ДИНАМИЧЕСКИ: сначала пробуем найти сохранённый
 * магазин в базе (форма в разделе «Настройки»), и только если его нет —
 * используем OZON_CLIENT_ID/OZON_API_KEY из переменных окружения (для
 * обратной совместимости с тем, кто настраивал сервер до появления формы).
 */

interface OzonCredentials {
  clientId: string;
  apiKey: string;
  baseUrl: string;
}

async function getOzonCredentials(): Promise<OzonCredentials | null> {
  const store = await prisma.ozonStore.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (store?.clientId && store?.apiKey) {
    return { clientId: store.clientId, apiKey: store.apiKey, baseUrl: env.ozon.baseUrl };
  }
  if (env.ozon.clientId && env.ozon.apiKey) {
    return { clientId: env.ozon.clientId, apiKey: env.ozon.apiKey, baseUrl: env.ozon.baseUrl };
  }
  return null;
}

interface OzonPostingProduct {
  sku: number;
  offer_id: string;
  name: string;
  quantity: number;
  price: string;
}

interface OzonPosting {
  posting_number: string;
  order_id: number;
  order_number: string;
  status: string;
  in_process_at: string;
  shipment_date: string;
  delivery_method?: { name?: string };
  analytics_data?: { city?: string; delivery_type?: string };
  products: OzonPostingProduct[];
}

interface OzonFinanceTransaction {
  operation_type: string;
  operation_type_name: string;
  posting: { posting_number: string };
  amount: number; // сумма операции (может быть отрицательной = списание)
  accruals_for_sale?: number;
  sale_commission?: number;
  delivery_charge?: number;
  return_delivery_charge?: number;
  services?: { name: string; price: number }[];
}

export class OzonClient {
  async isConfigured(): Promise<boolean> {
    const creds = await getOzonCredentials();
    return Boolean(creds?.clientId && creds?.apiKey);
  }

  private async getHttp(): Promise<AxiosInstance> {
    const creds = await getOzonCredentials();
    if (!creds) {
      throw new Error('Ozon API не настроен: добавьте магазин в разделе «Настройки» или задайте OZON_CLIENT_ID/OZON_API_KEY в .env');
    }
    return axios.create({
      baseURL: creds.baseUrl,
      headers: {
        'Client-Id': creds.clientId,
        'Api-Key': creds.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });
  }

  async fetchOrders(params: { dateFrom: Date; dateTo: Date }): Promise<NormalizedOrder[]> {
    const http = await this.getHttp();
    const postings = await this.fetchAllFbsPostings(http, params.dateFrom, params.dateTo);
    const financeByPosting = await this.fetchFinanceByPosting(http, params.dateFrom, params.dateTo);

    const orders = postings.map((posting) => this.toNormalizedOrder(posting, financeByPosting.get(posting.posting_number)));

    logger.info(`[Ozon] Загружено отправлений: ${orders.length}`);
    return orders;
  }

  private async fetchAllFbsPostings(http: AxiosInstance, dateFrom: Date, dateTo: Date): Promise<OzonPosting[]> {
    const limit = 100;
    let offset = 0;
    const all: OzonPosting[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await http.post('/v3/posting/fbs/list', {
        dir: 'asc',
        filter: {
          since: dateFrom.toISOString(),
          to: dateTo.toISOString(),
        },
        limit,
        offset,
        with: { analytics_data: true, financial_data: false },
      });

      const postings: OzonPosting[] = data.result?.postings ?? [];
      all.push(...postings);

      if (postings.length < limit) break;
      offset += limit;
    }

    return all;
  }

  /**
   * Финансовые транзакции содержат фактическую комиссию за продажу,
   * стоимость логистики/обратной логистики и доп. услуги (упаковка,
   * эквайринг и т.д.), сгруппированные по posting_number.
   */
  private async fetchFinanceByPosting(
    http: AxiosInstance,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<Map<string, { commission: number; logistics: number; other: number }>> {
    const result = new Map<string, { commission: number; logistics: number; other: number }>();
    const pageSize = 1000;
    let page = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await http.post('/v3/finance/transaction/list', {
        filter: {
          date: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
          transaction_type: 'all',
        },
        page,
        page_size: pageSize,
      });

      const operations: OzonFinanceTransaction[] = data.result?.operations ?? [];
      for (const op of operations) {
        const postingNumber = op.posting?.posting_number;
        if (!postingNumber) continue;

        const entry = result.get(postingNumber) ?? { commission: 0, logistics: 0, other: 0 };
        entry.commission += Math.abs(op.sale_commission ?? 0);
        entry.logistics += Math.abs(op.delivery_charge ?? 0) + Math.abs(op.return_delivery_charge ?? 0);
        entry.other += (op.services ?? []).reduce((sum, s) => sum + Math.abs(s.price), 0);
        result.set(postingNumber, entry);
      }

      const totalPages = Math.ceil((data.result?.row_count ?? 0) / pageSize);
      if (page >= totalPages || operations.length === 0) break;
      page += 1;
    }

    return result;
  }

  private toNormalizedOrder(
    posting: OzonPosting,
    finance?: { commission: number; logistics: number; other: number },
  ): NormalizedOrder {
    const items: NormalizedOrderItem[] = (posting.products ?? []).map((p) => ({
      externalSku: p.offer_id,
      name: p.name,
      quantity: p.quantity,
      price: Number(p.price),
    }));

    const totalRevenue = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    return {
      externalId: posting.posting_number,
      marketplace: 'OZON',
      status: posting.status,
      orderDate: new Date(posting.in_process_at ?? posting.shipment_date),
      deliveryType: posting.analytics_data?.delivery_type ?? posting.delivery_method?.name,
      city: posting.analytics_data?.city,
      totalRevenue,
      marketplaceCommission: finance?.commission ?? 0,
      logisticsCost: finance?.logistics ?? 0,
      acquiringCost: 0,
      otherFees: finance?.other ?? 0,
      items,
      raw: posting,
    };
  }
}

export const ozonClient = new OzonClient();
