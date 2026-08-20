import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { NormalizedOrder, NormalizedOrderItem } from '../types';

/**
 * Клиент для "Магазин на Kaspi.kz" API (JSON:API формат).
 * Документация: https://guide.kaspi.kz/partner/ru/shop/api/general
 *
 * ВАЖНО: Kaspi время от времени меняет названия query-параметров фильтрации
 * заказов (state/status, диапазоны дат). Если после запуска сервера заказы
 * не подтягиваются — сверьте параметры ниже с актуальным разделом
 * "Заказы" в Kaspi Гид для партнёров и поправьте buildOrdersQuery().
 */

interface KaspiOrderAttributes {
  code: string;
  state: string; // NEW, SIGN_REQUIRED, APPROVED_BY_BANK, ACCEPTED_BY_MERCHANT, COMPLETED, CANCELLED, RETURNED и т.д.
  status: string;
  totalPrice: number;
  creationDate: number; // unix ms
  deliveryMode?: string;
  paymentMode?: string;
  kaspiDelivery?: boolean;
  city?: { name?: string };
}

interface KaspiJsonApiResource<TAttrs> {
  id: string;
  type: string;
  attributes: TAttrs;
  relationships?: Record<string, unknown>;
}

interface KaspiListResponse<TAttrs> {
  data: KaspiJsonApiResource<TAttrs>[];
  meta?: { totalCount?: number; pageCount?: number };
}

interface KaspiEntryAttributes {
  quantity: number;
  totalPrice: number;
  basePrice?: number;
  deliveryCost?: number;
}

export interface KaspiFetchedOrder {
  order: NormalizedOrder;
}

export class KaspiClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: env.kaspi.baseUrl,
      headers: {
        'X-Auth-Token': env.kaspi.token,
        'Content-Type': 'application/vnd.api+json',
      },
      timeout: 20000,
    });
  }

  get isConfigured() {
    return env.kaspi.isConfigured;
  }

  /**
   * Получить список заказов за период. Kaspi отдаёт данные постранично
   * (page[number], page[size]) в формате JSON:API.
   */
  async fetchOrders(params: { dateFrom: Date; dateTo: Date; pageSize?: number }): Promise<NormalizedOrder[]> {
    const pageSize = params.pageSize ?? 100;
    let pageNumber = 0;
    const allOrders: NormalizedOrder[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await this.http.get<KaspiListResponse<KaspiOrderAttributes>>('/orders', {
        params: {
          'page[number]': pageNumber,
          'page[size]': pageSize,
          'filter[orders][creationDate][$ge]': params.dateFrom.getTime(),
          'filter[orders][creationDate][$le]': params.dateTo.getTime(),
        },
      });

      if (!data.data?.length) break;

      for (const resource of data.data) {
        const items = await this.fetchOrderEntries(resource.id);
        allOrders.push(this.toNormalizedOrder(resource, items));
      }

      const totalPages = data.meta?.pageCount ?? 1;
      pageNumber += 1;
      if (pageNumber >= totalPages) break;
    }

    logger.info(`[Kaspi] Загружено заказов: ${allOrders.length}`);
    return allOrders;
  }

  /**
   * Получить состав заказа (товарные позиции) по id заказа.
   */
  private async fetchOrderEntries(orderId: string): Promise<NormalizedOrderItem[]> {
    try {
      const { data } = await this.http.get(`/orders/${orderId}/entries`, {
        params: { include: 'product' },
      });

      const resources: KaspiJsonApiResource<KaspiEntryAttributes>[] = data.data ?? [];
      const included: any[] = data.included ?? [];

      return resources.map((entry) => {
        const relationships: any = entry.relationships ?? {};
        const productLinkId = relationships.product?.data?.id;
        const productRef = included.find((inc) => inc.type === 'products' && inc.id === productLinkId);
        const merchantSku = productRef?.attributes?.sku ?? productRef?.attributes?.code ?? entry.id;
        const name = productRef?.attributes?.name ?? 'Товар без названия';

        return {
          externalSku: String(merchantSku),
          name,
          quantity: entry.attributes.quantity ?? 1,
          price:
            entry.attributes.quantity > 0
              ? entry.attributes.totalPrice / entry.attributes.quantity
              : entry.attributes.totalPrice,
        };
      });
    } catch (err) {
      logger.warn({ err, orderId }, '[Kaspi] Не удалось получить состав заказа');
      return [];
    }
  }

  private toNormalizedOrder(
    resource: KaspiJsonApiResource<KaspiOrderAttributes>,
    items: NormalizedOrderItem[],
  ): NormalizedOrder {
    const attrs = resource.attributes;

    // Kaspi не отдаёт комиссию и логистику напрямую в заказе — они
    // рассчитываются в sync.service.ts на основе официальной таблицы
    // комиссий (src/integrations/kaspi.categories.ts) и тарифов доставки
    // (src/integrations/kaspi.delivery.ts), используя категорию/вес товара
    // из карточки Product. Здесь оставляем 0 — это лишь заготовка, которую
    // sync.service дополнит после сопоставления товарных позиций.
    const marketplaceCommission = 0;
    const logisticsCost = 0;
    const acquiringCost = 0;

    return {
      externalId: attrs.code,
      marketplace: 'KASPI',
      status: attrs.state ?? attrs.status,
      orderDate: new Date(attrs.creationDate),
      deliveryType: attrs.deliveryMode,
      city: attrs.city?.name,
      totalRevenue: attrs.totalPrice ?? items.reduce((s, i) => s + i.price * i.quantity, 0),
      marketplaceCommission,
      logisticsCost,
      acquiringCost,
      otherFees: 0,
      items,
      raw: resource,
      kaspiDelivery: attrs.kaspiDelivery,
      kaspiInternalId: resource.id,
    };
  }

  /**
   * Принять новый заказ (перевести в статус ACCEPTED_BY_MERCHANT).
   * См. Kaspi Гид: "Как принять новый заказ?"
   */
  async acceptOrder(kaspiInternalId: string, code: string): Promise<void> {
    await this.http.post('/orders', {
      data: {
        type: 'orders',
        id: kaspiInternalId,
        attributes: { code, status: 'ACCEPTED_BY_MERCHANT' },
      },
    });
  }

  /**
   * Сформировать накладную для передачи заказа на Kaspi Доставку —
   * технически это перевод заказа в статус ASSEMBLE с указанием количества
   * мест (коробок/упаковок). После этого печатную накладную можно скачать
   * в личном кабинете Kaspi — API не отдаёт готовый PDF, только меняет статус.
   * См. Kaspi Гид: "Как сформировать накладную для передачи заказа на Kaspi Доставку?"
   */
  async formWaybill(kaspiInternalId: string, numberOfSpace: number): Promise<void> {
    await this.http.post('/orders', {
      data: {
        type: 'orders',
        id: kaspiInternalId,
        attributes: { status: 'ASSEMBLE', numberOfSpace: String(numberOfSpace) },
      },
    });
  }
}

export const kaspiClient = new KaspiClient();
