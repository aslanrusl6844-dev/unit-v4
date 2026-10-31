import { prisma } from '../db/prisma';
import { teezClient } from '../integrations/teez.client';
import { logger } from '../utils/logger';
import { NormalizedOrder } from '../types';

/**
 * Синхронизация заказов Teez (отдельно от sync.service.ts, чтобы не трогать
 * Kaspi/Ozon/WB). Товары в каталог учёта автоматически НЕ создаются: у Teez в
 * заказе есть только штрихкод и название, поэтому себестоимость подставляется
 * лишь если товар найден по SKU = штрихкод или по точному названию, иначе
 * себестоимость 0 и позиция помечается как «без товара учёта» (productId пуст).
 */
async function findProductForTeezItem(barcode: string, name: string) {
  const byBarcode = barcode
    ? await prisma.product.findFirst({ where: { sku: barcode } })
    : null;
  if (byBarcode) return byBarcode;
  if (!name) return null;
  return prisma.product.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
}

async function persistTeezOrder(order: NormalizedOrder): Promise<{ matched: number; unmatched: number }> {
  let matched = 0;
  let unmatched = 0;

  const orderRevenue = order.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const itemsData = [];
  for (const item of order.items) {
    const product = await findProductForTeezItem(item.externalSku, item.name);
    if (product) matched += 1;
    else unmatched += 1;
    itemsData.push({
      externalSku: item.externalSku,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      costPrice: product ? product.costPrice + product.packagingCost : 0,
      productId: product?.id ?? null,
      // Комиссия позиции — доля комиссии заказа по доле выручки.
      commission: orderRevenue > 0 ? (order.marketplaceCommission * item.price * item.quantity) / orderRevenue : 0,
      itemLogistics: 0,
    });
  }

  const orderData = {
    marketplace: order.marketplace,
    externalId: order.externalId,
    status: order.status,
    orderDate: order.orderDate,
    deliveryType: order.deliveryType,
    city: order.city,
    totalRevenue: order.totalRevenue,
    marketplaceCommission: order.marketplaceCommission,
    logisticsCost: order.logisticsCost,
    acquiringCost: order.acquiringCost,
    otherFees: order.otherFees,
    rawData: JSON.stringify(order.raw ?? {}),
  };

  const existing = await prisma.order.findUnique({
    where: { marketplace_externalId: { marketplace: order.marketplace, externalId: order.externalId } },
  });

  if (existing) {
    await prisma.orderItem.deleteMany({ where: { orderId: existing.id } });
    await prisma.order.update({ where: { id: existing.id }, data: { ...orderData, items: { create: itemsData } } });
  } else {
    await prisma.order.create({ data: { ...orderData, items: { create: itemsData } } });
  }

  return { matched, unmatched };
}

/**
 * В Teez одна строка API = одна товарная позиция. Если в заказе несколько
 * позиций, они приходят строками с одним номером — склеиваем в один заказ,
 * иначе каждая следующая затёрла бы предыдущую.
 */
export function mergeTeezOrders(orders: NormalizedOrder[]): NormalizedOrder[] {
  const byId = new Map<string, NormalizedOrder>();
  for (const o of orders) {
    const prev = byId.get(o.externalId);
    if (!prev) {
      byId.set(o.externalId, { ...o, items: [...o.items] });
      continue;
    }
    prev.items.push(...o.items);
    prev.totalRevenue = Math.round((prev.totalRevenue + o.totalRevenue) * 100) / 100;
    prev.marketplaceCommission = Math.round((prev.marketplaceCommission + o.marketplaceCommission) * 100) / 100;
    // Заказ считается продажей, пока жива хотя бы одна позиция.
    const dead = (st: string) => st === 'CANCELLED' || st === 'RETURNED';
    if (dead(prev.status) && !dead(o.status)) prev.status = o.status;
  }
  return [...byId.values()];
}

export async function syncTeezOrders(dateFrom: Date, dateTo: Date) {
  if (!(await teezClient.isConfigured())) {
    logger.warn('[Teez] Ключи не заданы — синхронизация пропущена');
    return { ordersProcessed: 0, productsCreated: 0, unmatchedItems: 0 };
  }

  const log = await prisma.syncLog.create({ data: { marketplace: 'TEEZ', status: 'RUNNING' } });

  try {
    const orders = mergeTeezOrders(await teezClient.fetchOrders({ dateFrom, dateTo }));
    let unmatchedItems = 0;
    for (const order of orders) {
      const res = await persistTeezOrder(order);
      unmatchedItems += res.unmatched;
    }
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS', ordersProcessed: orders.length, finishedAt: new Date() },
    });
    return { ordersProcessed: orders.length, productsCreated: 0, unmatchedItems };
  } catch (err: any) {
    logger.error({ err }, '[Teez] Ошибка синхронизации');
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'ERROR', message: String(err?.message ?? err), finishedAt: new Date() },
    });
    throw err;
  }
}
