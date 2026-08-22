import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { NormalizedOrder, NormalizedOrderItem } from '../types';

/**
 * Клиент для Wildberries Statistics API.
 * Документация: https://dev.wildberries.ru/en/docs/openapi/reports
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
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: env.wb.statsBaseUrl,
      headers: { Authorization: env.wb.apiToken },
      timeout: 30000,
    });
  }

  get isConfigured() {
    return env.wb.isConfigured;
  }

  async fetchOrders(params: { dateFrom: Date; dateTo: Date }): Promise<NormalizedOrder[]> {
    const rows = await this.fetchOrderRows(params.dateFrom);
    const financeMap = await this.fetchFinanceBySrid(params.dateFrom, params.dateTo);

    const filtered = rows.filter((r) => {
      const d = new Date(r.date);
      return d >= params.dateFrom && d <= params.dateTo;
    });

    const orders = filtered.map((row) => this.toNormalizedOrder(row, financeMap.get(row.srid)));
    logger.info(`[Wildberries] Загружено заказов: ${orders.length}`);
    return orders;
  }

  /** Постранично тянет /api/v1/supplier/orders, используя lastChangeDate для пагинации. */
  private async fetchOrderRows(dateFrom: Date): Promise<WbOrderRow[]> {
    const all: WbOrderRow[] = [];
    let cursor = dateFrom.toISOString();

    for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
      const { data } = await this.http.get<WbOrderRow[]>('/api/v1/supplier/orders', {
        params: { dateFrom: cursor, flag: 0 },
      });

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
  private async fetchFinanceBySrid(dateFrom: Date, dateTo: Date): Promise<Map<string, WbFinanceTotals>> {
    const map = new Map<string, WbFinanceTotals>();
    const limit = 100000;
    let rrdId = 0;

    for (let page = 0; page < MAX_PAGES_SAFETY; page++) {
      const { data } = await this.http.get<WbRealizationRow[]>('/api/v5/supplier/reportDetailByPeriod', {
        params: {
          dateFrom: dateFrom.toISOString().slice(0, 10),
          dateTo: dateTo.toISOString().slice(0, 10),
          limit,
          rrdid: rrdId,
        },
      });

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
    const items: NormalizedOrderItem[] = [
      {
        externalSku: row.supplierArticle || String(row.nmId),
        name: row.subject || row.supplierArticle || `Товар WB ${row.nmId}`,
        quantity: 1,
        price,
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
