import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { NormalizedOrder, NormalizedOrderItem } from '../types';

/**
 * Клиент для Wildberries Statistics API + Content API.
 * Документация: https://dev.wildberries.ru/en/docs/openapi/reports
 *
 * Токен берётся ДИНАМИЧЕСКИ: сначала пробуем найти сохранённый магазин в
 * базе (форма в разделе «Настройки»), и только если его нет — используем
 * WB_API_TOKEN из переменных окружения (для обратной совместимости).
 *
 * Устроено иначе, чем у Kaspi/Ozon:
 * - Заказы отдаются построчно, 1 строка = 1 заказ = 1 товар (без вложенных
 *   позиций), уникальный идентификатор — поле "srid".
 * - У эндпоинта нет "dateTo" — только "dateFrom", а постранично нужно идти,
 *   подставляя "lastChangeDate" последней строки предыдущего ответа.
 * - Комиссию и логистику отдаёт ОТДЕЛЬНЫЙ отчёт о реализации
 *   (reportDetailByPeriod) — сопоставляем с заказами по тому же полю "srid".
 *   Свежие заказы могут ещё не попасть в этот отчёт (WB считает его не сразу) —
 *   тогда комиссия по ним временно будет нулевой, это нормально и подтянется
 *   при следующей синхронизации.
 */

const MAX_PAGES_SAFETY = 50; // защита от случайного бесконечного цикла пагинации
const MAX_429_RETRIES = 3;
const PACING_DELAY_MS = 350; // небольшая пауза между запросами подряд — снижает риск упереться в лимит вообще

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Обёртка вокруг любого запроса к WB API: при 429 (Too Many Requests)
 * читает заголовок X-Ratelimit-Retry (сколько секунд ждать — так советует
 * официальная документация WB), ждёт и повторяет запрос — до
 * MAX_429_RETRIES раз. Если лимит так и не снялся — кидает понятную
 * ошибку на русском, а не сырой "Request failed with status code 429".
 */
async function withRetryOn429<T>(fn: () => Promise<T>, context: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.response?.status !== 429) throw err;

      if (attempt >= MAX_429_RETRIES) {
        logger.error({ context }, '[Wildberries] 429 — попытки повтора исчерпаны');
        throw new Error('WB временно ограничил запросы, подождите минуту и попробуйте синхронизацию ещё раз.');
      }

      const headers = err.response?.headers ?? {};
      const retryHeader = headers['x-ratelimit-retry'] ?? headers['retry-after'];
      const waitSec = Number(retryHeader) > 0 ? Number(retryHeader) : 20; // разумный дефолт, если заголовка нет
      logger.warn(`[Wildberries] 429 Too Many Requests (${context}) — жду ${waitSec}с, попытка ${attempt + 1}/${MAX_429_RETRIES}`);
      await sleep(waitSec * 1000);
    }
  }
  // Формально недостижимо (цикл либо возвращает, либо кидает выше), но нужно для типов.
  throw new Error('WB временно ограничил запросы, подождите минуту и попробуйте синхронизацию ещё раз.');
}

async function getWbToken(): Promise<string | null> {
  const store = await prisma.wbStore.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (store?.apiToken) return store.apiToken;
  if (env.wb.apiToken) return env.wb.apiToken;
  return null;
}

interface WbOrderRow {
  date: string;
  lastChangeDate: string;
  warehouseType?: string;
  warehouseName?: string;
  regionName?: string;
  supplierArticle?: string;
  nmId: number;
  subject?: string;
  priceWithDisc?: number;
  finishedPrice?: number;
  totalPrice?: number;
  isCancel: boolean;
  srid: string;
}

interface WbRealizationRow {
  srid?: string;
  ppvz_sales_commission?: number;
  delivery_rub?: number;
  rebill_logistic_cost?: number;
  acquiring_fee?: number;
  rrd_id?: number;
}

interface WbFinanceTotals {
  commission: number;
  logistics: number;
  acquiring: number;
}

export class WbClient {
  async isConfigured(): Promise<boolean> {
    const token = await getWbToken();
    return Boolean(token);
  }

  private async getHttp(): Promise<AxiosInstance> {
    const token = await getWbToken();
    if (!token) {
      throw new Error('Wildberries API не настроен: добавьте магазин в разделе «Настройки» или задайте WB_API_TOKEN в .env');
    }
    return axios.create({
      baseURL: env.wb.statsBaseUrl,
      headers: { Authorization: token },
      timeout: 30000,
    });
  }

  // Карточки товаров живут на ДРУГОМ хосте WB API (Content API, не
  // Statistics) — и токен для него должен быть с категорией доступа
  // "Контент". Если используется токен только со статистикой — этот
  // конкретный метод (fetchCatalog) вернёт ошибку авторизации, но
  // синхронизация заказов (fetchOrders) продолжит работать как обычно,
  // это не связанные между собой категории доступа.
  private async getContentHttp(): Promise<AxiosInstance> {
    const token = await getWbToken();
    if (!token) {
      throw new Error('Wildberries API не настроен: добавьте магазин в разделе «Настройки» или задайте WB_API_TOKEN в .env');
    }
    return axios.create({
      baseURL: env.wb.contentBaseUrl,
      headers: { Authorization: token },
      timeout: 30000,
    });
  }

  // Цены живут на ТРЕТЬЕМ хосте WB API (Prices/discounts, отдельно от
  // Statistics и Content) — токен должен иметь категорию доступа "Цены и
  // скидки". Официальная документация: https://openapi.wb.ru/prices/api/en/
  private async getPricesHttp(): Promise<AxiosInstance> {
    const token = await getWbToken();
    if (!token) {
      throw new Error('Wildberries API не настроен: добавьте магазин в разделе «Настройки» или задайте WB_API_TOKEN в .env');
    }
    return axios.create({
      baseURL: env.wb.pricesBaseUrl,
      headers: { Authorization: token },
      timeout: 30000,
    });
  }

  /**
   * Текущие цены товаров — GET /api/v2/list/goods/filter (без указания
   * артикула — отдаёт по ВСЕМ товарам сразу, так рекомендует официальная
   * документация). Подтверждённый формат ответа:
   *   { data: { listGoods: [ { nmID, vendorCode, sizes: [{ price, discountedPrice }], ... } ] } }
   * Берём discountedPrice — это реальная цена, которую платит покупатель
   * (с учётом скидки продавца), а не список price без скидки.
   */
  async fetchPrices(): Promise<Map<number, number>> {
    const pricesHttp = await this.getPricesHttp();
    const result = new Map<number, number>();

    try {
      const response = await withRetryOn429(() => pricesHttp.get('/api/v2/list/goods/filter'), 'цены товаров');
      // Терпимый разбор — пробуем несколько вероятных путей к списку, на
      // случай если структура чуть отличается от задокументированной.
      const goods: Array<{ nmID: number; sizes?: Array<{ price?: number; discountedPrice?: number }> }> =
        response.data?.data?.listGoods ?? response.data?.listGoods ?? [];
      if (goods.length === 0) {
        // Ничего не нашли — логируем СЫРОЙ ответ целиком, чтобы при следующей
        // проблеме сразу было видно точную структуру, а не гадать заново.
        logger.warn({ sampleResponse: response.data }, '[Wildberries] /api/v2/list/goods/filter вернул пустой список товаров — см. sampleResponse');
      }
      goods.forEach((item) => {
        const size = item.sizes?.[0];
        const price = size?.discountedPrice ?? size?.price;
        if (item.nmID && price != null) result.set(item.nmID, price);
      });
    } catch (err: any) {
      if (err.message?.includes('WB временно ограничил')) throw err;
      const wbErrorBody = err?.response?.data;
      logger.error(
        { status: err?.response?.status, body: wbErrorBody },
        '[Wildberries] Ошибка запроса цен (/api/v2/list/goods/filter, проверьте категорию доступа токена "Цены и скидки")',
      );
      throw new Error(
        `Wildberries API вернул ошибку ${err?.response?.status ?? ''} при запросе цен: ` +
          `${JSON.stringify(wbErrorBody) || err?.message}`,
      );
    }

    logger.info(`[Wildberries] Получено цен: ${result.size}`);
    return result;
  }

  /**
   * Полный каталог карточек товаров — POST /content/v2/get/cards/list,
   * с постраничной курсорной пагинацией (limit + cursor.updatedAt/nmID из
   * предыдущего ответа). У каждой карточки: nmID (номер WB), vendorCode
   * (= supplierArticle, наш wbArticle) и title (название).
   */
  async fetchCatalog(): Promise<Array<{ vendorCode: string; name: string; nmId: number; subject?: string }>> {
    const contentHttp = await this.getContentHttp();
    const catalog: Array<{ vendorCode: string; name: string; nmId: number; subject?: string }> = [];
    let cursor: { limit: number; updatedAt?: string; nmID?: number } = { limit: 100 };

    for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
      if (page > 0) await sleep(PACING_DELAY_MS); // пауза между страницами — снижает риск 429
      let data: any;
      try {
        const response = await withRetryOn429(
          () => contentHttp.post('/content/v2/get/cards/list', { settings: { cursor, filter: { withPhoto: -1 } } }),
          'каталог карточек',
        );
        data = response.data;
      } catch (err: any) {
        if (err.message?.includes('WB временно ограничил')) throw err; // уже понятное сообщение, прокидываем как есть
        const wbErrorBody = err?.response?.data;
        logger.error(
          { status: err?.response?.status, body: wbErrorBody },
          '[Wildberries] Ошибка запроса карточек товаров (проверьте, что токен имеет категорию доступа "Контент")',
        );
        throw new Error(
          `Wildberries API вернул ошибку ${err?.response?.status ?? ''} при запросе карточек товаров: ` +
            `${JSON.stringify(wbErrorBody) || err?.message}`,
        );
      }

      // "Предмет" WB (subjectName) — ключ для поиска комиссии в справочнике
      // (см. wb.categories.ts). Нужен именно ТЕКСТ предмета, как в таблице
      // тарифов, не subjectID (числовой внутренний идентификатор WB).
      // Точное имя поля в Content API документировано не так подробно, как
      // у Statistics API (где мы уже уверенно используем row.subject) —
      // пробуем несколько вероятных вариантов, а не полагаемся на одно имя.
      const cards: Array<{ nmID: number; vendorCode: string; title?: string; subjectName?: string; subject?: string; object?: string }> = data.cards ?? [];
      cards.forEach((card) => {
        catalog.push({
          vendorCode: card.vendorCode,
          name: card.title?.trim() || `WB-товар ${card.vendorCode}`,
          nmId: card.nmID,
          subject: card.subjectName ?? card.subject ?? card.object,
        });
      });

      const total = data.cursor?.total ?? 0;
      // ВАЖНО: 0 — легитимное значение nmID (а не "данных нет"), поэтому
      // проверяем именно на undefined/null, а не через простое отрицание
      // (!0 === true в JS сломало бы пагинацию на ровном месте).
      if (total < cursor.limit || data.cursor?.nmID == null) break;
      cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
    }

    logger.info(`[Wildberries] В каталоге карточек товаров: ${catalog.length}`);
    return catalog;
  }

  async fetchOrders(params: { dateFrom: Date; dateTo: Date }): Promise<NormalizedOrder[]> {
    const http = await this.getHttp();
    const rows = await this.fetchOrderRows(http, params.dateFrom);
    await sleep(PACING_DELAY_MS); // пауза перед вторым тяжёлым запросом подряд
    const financeMap = await this.fetchFinanceBySrid(http, params.dateFrom, params.dateTo);

    const filtered = rows.filter((r) => {
      const d = new Date(r.date);
      return d >= params.dateFrom && d <= params.dateTo;
    });

    const orders = filtered.map((row) => this.toNormalizedOrder(row, financeMap.get(row.srid)));
    logger.info(`[Wildberries] Загружено заказов: ${orders.length}`);
    return orders;
  }

  /** Постранично тянет /api/v1/supplier/orders, используя lastChangeDate для пагинации. */
  private async fetchOrderRows(http: AxiosInstance, dateFrom: Date): Promise<WbOrderRow[]> {
    const all: WbOrderRow[] = [];
    let cursor = dateFrom.toISOString();

    for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
      if (page > 0) await sleep(PACING_DELAY_MS);
      const { data } = await withRetryOn429(
        () => http.get<WbOrderRow[]>('/api/v1/supplier/orders', { params: { dateFrom: cursor, flag: 0 } }),
        'список заказов',
      );

      if (!data?.length) break;
      all.push(...data);

      const lastRow = data[data.length - 1];
      if (!lastRow?.lastChangeDate || lastRow.lastChangeDate === cursor) break;
      cursor = lastRow.lastChangeDate;

      if (data.length < 1000) break; // страница явно неполная — дальше пусто
    }

    return all;
  }

  /** Тянет отчёт о реализации и суммирует комиссию/логистику/эквайринг по каждому srid. */
  private async fetchFinanceBySrid(http: AxiosInstance, dateFrom: Date, dateTo: Date): Promise<Map<string, WbFinanceTotals>> {
    const map = new Map<string, WbFinanceTotals>();
    const limit = 100000;
    let rrdId = 0;

    for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
      if (page > 0) await sleep(PACING_DELAY_MS);
      const { data } = await withRetryOn429(
        () => http.get<WbRealizationRow[]>('/api/v5/supplier/reportDetailByPeriod', {
          params: {
            dateFrom: dateFrom.toISOString().slice(0, 10),
            dateTo: dateTo.toISOString().slice(0, 10),
            limit,
            rrdid: rrdId,
          },
        }),
        'отчёт о реализации',
      );

      if (!data?.length) break;

      for (const row of data) {
        if (!row.srid) continue;
        const entry = map.get(row.srid) ?? { commission: 0, logistics: 0, acquiring: 0 };
        entry.commission += Math.abs(row.ppvz_sales_commission ?? 0);
        entry.logistics += Math.abs(row.delivery_rub ?? 0) + Math.abs(row.rebill_logistic_cost ?? 0);
        entry.acquiring += Math.abs(row.acquiring_fee ?? 0);
        map.set(row.srid, entry);
      }

      if (data.length < limit) break;
      rrdId = data[data.length - 1].rrd_id ?? 0;
      if (!rrdId) break;
    }

    return map;
  }

  private toNormalizedOrder(row: WbOrderRow, finance?: WbFinanceTotals): NormalizedOrder {
    const price = row.priceWithDisc ?? row.finishedPrice ?? row.totalPrice ?? 0;
    // Схема продажи — WB не отдаёт её отдельным явным полем, определяем по
    // типу склада: если склад принадлежит самому WB — это FBW (продажа со
    // склада WB), иначе — FBS (продажа со своего склада). Эвристика, а не
    // официально документированное поле — помечено как предположение в UI.
    const wbScheme: 'FBS' | 'FBW' = /wb|wildberries|склад wb/i.test(row.warehouseType || row.warehouseName || '') ? 'FBW' : 'FBS';
    const items: NormalizedOrderItem[] = [
      {
        externalSku: row.supplierArticle || String(row.nmId),
        name: row.subject || row.supplierArticle || `Товар WB ${row.nmId}`,
        quantity: 1,
        price,
        wbSubject: row.subject,
        wbScheme,
      },
    ];

    return {
      externalId: row.srid,
      marketplace: 'WB',
      status: row.isCancel ? 'CANCELLED' : 'NEW',
      orderDate: new Date(row.date),
      deliveryType: row.warehouseType || row.warehouseName,
      city: row.regionName,
      totalRevenue: price,
      marketplaceCommission: finance?.commission ?? 0,
      logisticsCost: finance?.logistics ?? 0,
      acquiringCost: finance?.acquiring ?? 0,
      otherFees: 0,
      items,
      raw: row,
    };
  }
}

export const wbClient = new WbClient();
