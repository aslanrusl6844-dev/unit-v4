import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { NormalizedOrder, NormalizedOrderItem } from '../types';

/**
 * Клиент для "Магазин на Kaspi.kz" API (JSON:API формат).
 * Документация: https://guide.kaspi.kz/partner/ru/shop/api/general
 *
 * ВАЖНО: Kaspi время от времени меняет названия query-параметров фильтрации
 * заказов (state/status, диапазоны дат). Если после запуска сервера заказы
 * не подтягиваются — сверьте параметры ниже с актуальным разделом
 * "Заказы" в Kaspi Гид для партнёров и поправьте buildOrdersQuery().
 *
 * Токен для запросов берётся ДИНАМИЧЕСКИ: сначала пробуем найти сохранённый
 * магазин в базе (форма «Добавить магазин» в разделе «Настройки»), и только
 * если его нет — используем KASPI_API_TOKEN из переменных окружения (для
 * обратной совместимости с тем, кто настраивал сервер до появления формы).
 */

interface KaspiCredentials {
  token: string;
  baseUrl: string;
  merchantUid: string;
}

export async function getKaspiCredentials(): Promise<KaspiCredentials | null> {
  const store = await prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (store?.apiToken) {
    return { token: store.apiToken, baseUrl: env.kaspi.baseUrl, merchantUid: store.merchantUid ?? env.kaspi.merchantUid };
  }
  if (env.kaspi.token) {
    return { token: env.kaspi.token, baseUrl: env.kaspi.baseUrl, merchantUid: env.kaspi.merchantUid };
  }
  return null;
}

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
  /** true/false — есть ли вообще откуда взять токен (БД или .env). */
  async isConfigured(): Promise<boolean> {
    const creds = await getKaspiCredentials();
    return Boolean(creds?.token);
  }

  private async getHttp(): Promise<AxiosInstance> {
    const creds = await getKaspiCredentials();
    if (!creds) {
      throw new Error('Kaspi API не настроен: добавьте магазин в разделе «Настройки» или задайте KASPI_API_TOKEN в .env');
    }
    // Явная проверка вместо того, чтобы дать axios упасть с непонятным
    // "Invalid URL" — если базовый адрес API вдруг оказался пустым или
    // не похож на настоящий URL, сразу говорим прямо, в чём дело.
    if (!creds.baseUrl || !/^https?:\/\//.test(creds.baseUrl)) {
      throw new Error(
        `Некорректный базовый адрес Kaspi API: "${creds.baseUrl}". Проверьте KASPI_API_BASE_URL в Environment Variables ` +
          `(должен быть похож на https://kaspi.kz/shop/api/v2) или просто удалите эту переменную, чтобы использовалось значение по умолчанию.`,
      );
    }
    return axios.create({
      baseURL: creds.baseUrl,
      headers: {
        'X-Auth-Token': creds.token,
        'Content-Type': 'application/vnd.api+json',
      },
      timeout: 20000,
    });
  }

  /**
   * Получить список заказов за период. Kaspi отдаёт данные постранично
   * (page[number], page[size]) в формате JSON:API.
   *
   * ВАЖНО: судя по официальным примерам Kaspi Гид, фильтр
   * filter[orders][state] присутствует в КАЖДОМ примере запроса — похоже,
   * что без него API возвращает 400. У Kaspi нет единого "покажи заказы
   * любого статуса" — поэтому запрашиваем ПО ОЧЕРЕДИ для каждого
   * известного состояния заказа и объединяем результат.
   */
  async fetchOrders(params: { dateFrom: Date; dateTo: Date; pageSize?: number }): Promise<NormalizedOrder[]> {
    const http = await this.getHttp();
    const pageSize = params.pageSize ?? 20; // как в официальном примере Kaspi Гид
    const allOrders: NormalizedOrder[] = [];
    const seenIds = new Set<string>();

    // Все известные значения state, которые встречаются в заказах Kaspi
    // (см. также STATUS_GROUPS в src/routes/orders.routes.ts).
    const STATES = [
      'NEW',
      'SIGN_REQUIRED',
      'APPROVED_BY_BANK',
      'ACCEPTED_BY_MERCHANT',
      'ASSEMBLE',
      'COMPLETED',
      'CANCELLED',
      'CANCELLING',
      'RETURNED',
      'ARCHIVE',
    ];

    for (const state of STATES) {
      let pageNumber = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let data: KaspiListResponse<KaspiOrderAttributes>;
        try {
          const response = await http.get<KaspiListResponse<KaspiOrderAttributes>>('/orders', {
            params: {
              'page[number]': pageNumber,
              'page[size]': pageSize,
              'filter[orders][state]': state,
              'filter[orders][creationDate][$ge]': params.dateFrom.getTime(),
              'filter[orders][creationDate][$le]': params.dateTo.getTime(),
            },
          });
          data = response.data;
        } catch (err: any) {
          // Логируем ТОЧНОЕ тело ответа Kaspi при ошибке — только по коду
          // статуса (400/401/403) не понять, что конкретно не устроило API,
          // а тело ответа обычно содержит понятное описание причины.
          const kaspiErrorBody = err?.response?.data;
          logger.error(
            { status: err?.response?.status, body: kaspiErrorBody, state, pageNumber },
            '[Kaspi] Ошибка запроса заказов',
          );
          throw new Error(
            `Kaspi API вернул ошибку ${err?.response?.status ?? ''} при запросе заказов (state=${state}): ` +
              `${JSON.stringify(kaspiErrorBody) || err?.message || err}`,
          );
        }

        if (!data.data?.length) break;

        for (const resource of data.data) {
          if (seenIds.has(resource.id)) continue; // на всякий случай, вдруг заказ попал в выборку дважды
          seenIds.add(resource.id);
          const items = await this.fetchOrderEntries(http, resource.id);
          allOrders.push(this.toNormalizedOrder(resource, items));
        }

        const totalPages = data.meta?.pageCount ?? 1;
        pageNumber += 1;
        if (pageNumber >= totalPages) break;
      }
    }

    logger.info(`[Kaspi] Загружено заказов: ${allOrders.length}`);
    return allOrders;
  }

  /**
   * Получить состав заказа (товарные позиции) по id заказа.
   */
  private async fetchOrderEntries(http: AxiosInstance, orderId: string): Promise<NormalizedOrderItem[]> {
    try {
      const { data } = await http.get(`/orders/${orderId}/entries`, {
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
    } catch (err: any) {
      logger.warn(
        { status: err?.response?.status, body: err?.response?.data, orderId },
        '[Kaspi] Не удалось получить состав заказа',
      );
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
    const http = await this.getHttp();
    await http.post('/orders', {
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
    const http = await this.getHttp();
    await http.post('/orders', {
      data: {
        type: 'orders',
        id: kaspiInternalId,
        attributes: { status: 'ASSEMBLE', numberOfSpace: String(numberOfSpace) },
      },
    });
  }
}

export const kaspiClient = new KaspiClient();
