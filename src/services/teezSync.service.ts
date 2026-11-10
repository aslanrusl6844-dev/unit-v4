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
    ? await prisma.product.findFirst({ where: { OR: [{ teezSku: barcode }, { sku: barcode }] } })
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
    // Ставка комиссии Teez по этому товару — из заказа (Teez сам считает комиссию по категории).
    const rate = Number((order.raw as any)?.commissionPercent);
    if (product && Number.isFinite(rate) && rate > 0 && product.teezCommissionRatePct !== rate) {
      await prisma.product.update({ where: { id: product.id }, data: { teezCommissionRatePct: rate } });
    }
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
    settledAt: order.settledAt ?? null,
    payoutAmount: order.payoutAmount ?? null,
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
    if (prev.payoutAmount != null || o.payoutAmount != null) prev.payoutAmount = Math.round(((prev.payoutAmount ?? 0) + (o.payoutAmount ?? 0)) * 100) / 100;
    if (!prev.settledAt || (o.settledAt && o.settledAt > prev.settledAt)) prev.settledAt = o.settledAt ?? prev.settledAt;
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

/**
 * Каталог Teez → «Товары»: список товаров + детали (SKU, штрихкод, цена, фото).
 * Товар учёта ищем по штрихкоду Teez (teezSku), затем по совпадающему артикулу
 * (sku / Kaspi / Ozon / WB), затем по точному названию; не нашли — создаём новый
 * (себестоимость 0 — её надо вписать). Остаток берём из списка товаров Teez.
 */
export async function syncTeezCatalog() {
  if (!(await teezClient.isConfigured())) return { total: 0, created: 0, updated: 0, skipped: 'not-configured' as const };
  const list = await teezClient.fetchProducts();
  const stockById = new Map(list.map((p) => [Number(p.productId), Number(p.totalWmsQuantity ?? 0)]));
  const details = await teezClient.fetchProductDetails(list.map((p) => Number(p.productId)));
  let created = 0;
  let updated = 0;
  for (const d of details) {
    const key = d.barcode || `teez-${d.skuId}`;
    const singleSku = details.filter((x) => x.productId === d.productId).length === 1;
    let product = await prisma.product.findFirst({ where: { teezSku: key } });
    if (!product) {
      product = await prisma.product.findFirst({
        where: { OR: [{ sku: key }, { kaspiSku: key }, { ozonOfferId: key }, { wbArticle: key }, { shopArticle: key }] },
      });
    }
    if (!product && d.name) product = await prisma.product.findFirst({ where: { name: { equals: d.name, mode: 'insensitive' } } });
    const data: Record<string, any> = {
      teezSku: key,
      teezProductId: String(d.productId),
      teezStock: singleSku ? stockById.get(d.productId) ?? null : null,
    };
    if (d.price != null && d.price > 0) Object.assign(data, { teezReferencePrice: d.price, teezReferencePriceUpdatedAt: new Date() });
    if (product) {
      if (!product.marketImages && d.photos.length) data.marketImages = JSON.stringify(d.photos);
      await prisma.product.update({ where: { id: product.id }, data });
      updated += 1;
    } else {
      const skuTaken = await prisma.product.findUnique({ where: { sku: key } });
      await prisma.product.create({
        data: {
          ...data,
          sku: skuTaken ? `teez-${d.skuId}` : key,
          name: d.name || `Товар Teez ${key}`,
          costPrice: 0,
          marketImages: d.photos.length ? JSON.stringify(d.photos) : null,
        },
      });
      created += 1;
    }
  }
  logger.info(`[Teez] Каталог: товаров ${list.length}, SKU ${details.length}, создано ${created}, обновлено ${updated}`);
  return { total: details.length, created, updated };
}
