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

  /**
   * Полный каталог товаров, СЕЙЧАС стоящих на продаже (не из заказов, а из
   * собственного метода Ozon "список товаров"):
   *   POST /v3/product/list — постранично отдаёт {product_id, offer_id}
   *     (v2/product/list официально отключён Ozon 09.02.2025 — используем
   *     актуальную v3-версию, иначе получаем "404 page not found")
   *   POST /v3/product/info/list — по списку id отдаёт name/статус
   *     (v2/product/info(/list) официально отключён Ozon 17.02.2025)
   * filter.visibility — судя по точному тексту ошибки Ozon ("invalid value
   * for enum field visibility: [" — ошибка ровно на символе "[") это
   * ОБЫЧНАЯ СТРОКА (enum), а не массив, как я ошибочно поставил в прошлый
   * раз. Отправляем строкой "VISIBLE" — "сейчас видны покупателям", а не
   * вообще все когда-либо созданные товары (включая давно снятые с продажи).
   * Разбор ответа сделан устойчивым к структуре — проверяет и
   * data.result.items, и data.items — на случай мелких отличий между
   * версиями API.
   */
  async fetchCatalog(): Promise<Array<{ offerId: string; name: string; active: boolean }>> {
    const http = await this.getHttp();
    const idPairs: Array<{ productId: number; offerId: string }> = [];
    let lastId = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let data: any;
      try {
        const response = await http.post('/v3/product/list', {
          filter: { visibility: 'VISIBLE' },
          last_id: lastId,
          limit: 100,
        });
        data = response.data;
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error({ status: err?.response?.status, body: ozonErrorBody }, '[Ozon] Ошибка запроса списка товаров');
        throw new Error(`Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе каталога: ${JSON.stringify(ozonErrorBody) || err?.message}`);
      }

      const result = data.result ?? data;
      const items: Array<{ product_id: number; offer_id: string }> = result?.items ?? [];
      items.forEach((i) => idPairs.push({ productId: i.product_id, offerId: i.offer_id }));

      lastId = result?.last_id ?? '';
      if (!items.length || !lastId) break;
    }

    logger.info(`[Ozon] В каталоге товаров (visibility=VISIBLE): ${idPairs.length}`);

    // Название и точный статус (archived) добираем пачками по 100 через info/list.
    const catalog: Array<{ offerId: string; name: string; active: boolean }> = [];
    for (let i = 0; i < idPairs.length; i += 100) {
      const chunk = idPairs.slice(i, i + 100);
      try {
        const { data } = await http.post('/v3/product/info/list', {
          offer_id: chunk.map((c) => c.offerId),
        });
        const result = data.result ?? data;
        const items: Array<{ offer_id: string; name?: string; archived?: boolean }> = result?.items ?? [];
        items.forEach((item) => {
          catalog.push({
            offerId: item.offer_id,
            name: item.name?.trim() || `Ozon-товар ${item.offer_id}`,
            // Если поле archived не пришло — считаем товар активным (лучше
            // показать лишний товар, чем незаметно потерять настоящий).
            active: item.archived !== true,
          });
        });
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error({ status: err?.response?.status, body: ozonErrorBody }, '[Ozon] Ошибка запроса деталей товаров');
        // Не прерываем всю синхронизацию из-за одной неудачной пачки — просто
        // пропускаем эти offer_id, остальные всё равно синхронизируются.
      }
    }

    return catalog;
  }

  async fetchOrders(params: { dateFrom: Date; dateTo: Date }): Promise<NormalizedOrder[]> {
    const http = await this.getHttp();
    const postings = await this.fetchAllFbsPostings(http, params.dateFrom, params.dateTo);
    const financeByPosting = await this.fetchFinanceByPosting(http, params.dateFrom, params.dateTo);

    const orders = postings.map((posting) => this.toNormalizedOrder(posting, financeByPosting.get(posting.posting_number)));

    logger.info(`[Ozon] Загружено отправлений: ${orders.length}`);
    return orders;
  }

  /**
   * Точная форма запроса к Ozon (для диагностики — см. п.1 вопроса):
   *
   *   POST {OZON_API_BASE_URL}/v3/posting/fbs/list
   *   Headers:
   *     Client-Id: <из формы в Настройках или OZON_CLIENT_ID>
   *     Api-Key:   <из формы в Настройках или OZON_API_KEY>
   *     Content-Type: application/json
   *   Body:
   *     {
   *       "dir": "asc",
   *       "filter": { "since": "<ISO-дата>", "to": "<ISO-дата>" },
   *       "limit": 100,
   *       "offset": 0,
   *       "with": { "analytics_data": true, "financial_data": false }
   *     }
   */
  private async fetchAllFbsPostings(http: AxiosInstance, dateFrom: Date, dateTo: Date): Promise<OzonPosting[]> {
    const limit = 100;
    let offset = 0;
    const all: OzonPosting[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const requestBody = {
        dir: 'asc',
        filter: {
          since: dateFrom.toISOString(),
          to: dateTo.toISOString(),
        },
        limit,
        offset,
        with: { analytics_data: true, financial_data: false },
      };

      let data: any;
      try {
        const response = await http.post('/v3/posting/fbs/list', requestBody);
        data = response.data;
      } catch (err: any) {
        // Логируем ТОЧНОЕ тело ответа Ozon при ошибке — по одному коду
        // статуса (400/401/403) не понять причину, а тело обычно содержит
        // понятное описание (например "wrong client-id format" и т.п.).
        const ozonErrorBody = err?.response?.data;
        logger.error(
          { status: err?.response?.status, body: ozonErrorBody, requestBody },
          '[Ozon] Ошибка запроса заказов (fbs/list)',
        );
        throw new Error(
          `Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе заказов: ` +
            `${JSON.stringify(ozonErrorBody) || err?.message || err}`,
        );
      }

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
      const requestBody = {
        filter: {
          date: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
          transaction_type: 'all',
        },
        page,
        page_size: pageSize,
      };

      let data: any;
      try {
        const response = await http.post('/v3/finance/transaction/list', requestBody);
        data = response.data;
      } catch (err: any) {
        const ozonErrorBody = err?.response?.data;
        logger.error(
          { status: err?.response?.status, body: ozonErrorBody, requestBody },
          '[Ozon] Ошибка запроса финансовых транзакций',
        );
        throw new Error(
          `Ozon API вернул ошибку ${err?.response?.status ?? ''} при запросе финансовых транзакций: ` +
            `${JSON.stringify(ozonErrorBody) || err?.message || err}`,
        );
      }

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
