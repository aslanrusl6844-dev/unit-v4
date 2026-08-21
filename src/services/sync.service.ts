import { prisma } from '../db/prisma';
import { kaspiClient } from '../integrations/kaspi.client';
import { ozonClient } from '../integrations/ozon.client';
import { wbClient } from '../integrations/wb.client';
import { calcKaspiCommissionAmount } from '../integrations/kaspi.categories';
import { calculateKaspiDeliveryCost } from '../integrations/kaspi.delivery';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { MarketplaceName, NormalizedOrder } from '../types';

interface ResolvedProductInfo {
  productId?: string;
  costPrice: number;
  weightKg: number;
  kaspiTopCategory?: string;
  kaspiLeafCategory?: string;
}

async function resolveProductInfo(marketplace: MarketplaceName, externalSku: string, itemName: string): Promise<ResolvedProductInfo> {
  const where =
    marketplace === 'KASPI'
      ? { kaspiSku: externalSku }
      : marketplace === 'OZON'
        ? { ozonOfferId: externalSku }
        : { wbArticle: externalSku };

  const product = await prisma.product.findFirst({ where });

  if (!product) {
    // Товар с таким SKU ещё не заведён вручную — создаём его автоматически
    // на основе данных заказа. У Kaspi нет API-эндпоинта "отдай мне список
    // всех моих товаров" (только методы ДОБАВЛЕНИЯ новых товаров), поэтому
    // это самый честный способ получить каталог: он собирается из реальных
    // продаж. Себестоимость по умолчанию 0 — обязательно укажите её в
    // разделе «Товары», иначе юнит-экономика будет считать нулевую себестоимость.
    try {
      const created = await prisma.product.create({
        data: {
          sku: `${marketplace.toLowerCase()}-${externalSku}`,
          name: itemName || externalSku,
          costPrice: 0,
          ...(marketplace === 'KASPI' ? { kaspiSku: externalSku } : {}),
          ...(marketplace === 'OZON' ? { ozonOfferId: externalSku } : {}),
          ...(marketplace === 'WB' ? { wbArticle: externalSku } : {}),
        },
      });
      logger.info(`[Каталог] Автоматически создан товар из заказа: ${created.name} (${marketplace} ${externalSku})`);
      return { productId: created.id, costPrice: 0, weightKg: created.weightKg };
    } catch (err) {
      // Гонка при параллельной синхронизации (SKU уже создан другим заказом
      // в это же мгновение) — просто ищем ещё раз, не считаем это ошибкой.
      const retry = await prisma.product.findFirst({ where });
      if (retry) return { productId: retry.id, costPrice: retry.costPrice + retry.packagingCost, weightKg: retry.weightKg };
      logger.warn({ err }, '[Каталог] Не удалось автоматически создать товар');
      return { costPrice: 0, weightKg: 0.5 };
    }
  }

  return {
    productId: product.id,
    costPrice: product.costPrice + product.packagingCost,
    weightKg: product.weightKg,
    kaspiTopCategory: product.kaspiTopCategory ?? undefined,
    kaspiLeafCategory: product.kaspiLeafCategory ?? undefined,
  };
}

/**
 * Для Kaspi считаем комиссию (по категории каждого товара, из официальной
 * тарифной таблицы) и логистику (по тарифу Kaspi Доставки, на основе
 * суммы/веса заказа), т.к. сам API Kaspi эти суммы не отдаёт.
 */
function enrichKaspiFinancials(
  order: NormalizedOrder,
  itemsWithInfo: Array<{ price: number; quantity: number; weightKg: number; kaspiTopCategory?: string; kaspiLeafCategory?: string }>,
): { marketplaceCommission: number; logisticsCost: number } {
  let marketplaceCommission = 0;
  let totalWeight = 0;

  for (const item of itemsWithInfo) {
    const itemRevenue = item.price * item.quantity;
    totalWeight += item.weightKg * item.quantity;

    if (item.kaspiTopCategory) {
      marketplaceCommission += calcKaspiCommissionAmount(itemRevenue, {
        topCategory: item.kaspiTopCategory,
        leafCategory: item.kaspiLeafCategory,
      });
    }
    // Если категория товара не указана в карточке — комиссия для этой
    // позиции не считается (0), чтобы не искажать отчёт неверной ставкой.
    // Заполните kaspiTopCategory/kaspiLeafCategory в разделе «Товары».
  }

  const logisticsCost = order.kaspiDelivery
    ? calculateKaspiDeliveryCost(order.totalRevenue, totalWeight, env.kaspi.defaultDeliveryZone)
    : 0;

  return { marketplaceCommission, logisticsCost };
}

async function persistOrder(order: NormalizedOrder): Promise<void> {
  const itemsWithCost = await Promise.all(
    order.items.map(async (item) => {
      const info = await resolveProductInfo(order.marketplace, item.externalSku, item.name);
      return { ...item, ...info };
    }),
  );

  const existing = await prisma.order.findUnique({
    where: { marketplace_externalId: { marketplace: order.marketplace, externalId: order.externalId } },
  });

  let { marketplaceCommission, logisticsCost } = order;
  if (order.marketplace === 'KASPI') {
    const kaspiFinancials = enrichKaspiFinancials(order, itemsWithCost);
    marketplaceCommission = kaspiFinancials.marketplaceCommission;
    logisticsCost = kaspiFinancials.logisticsCost;
  }

  const orderData = {
    marketplace: order.marketplace,
    externalId: order.externalId,
    status: order.status,
    orderDate: order.orderDate,
    deliveryType: order.deliveryType,
    city: order.city,
    kaspiInternalId: order.kaspiInternalId,
    totalRevenue: order.totalRevenue,
    marketplaceCommission,
    logisticsCost,
    acquiringCost: order.acquiringCost,
    otherFees: order.otherFees,
    rawData: JSON.stringify(order.raw ?? {}),
  };

  if (existing) {
    await prisma.orderItem.deleteMany({ where: { orderId: existing.id } });
    await prisma.order.update({
      where: { id: existing.id },
      data: {
        ...orderData,
        items: {
          create: itemsWithCost.map((i) => ({
            externalSku: i.externalSku,
            name: i.name,
            quantity: i.quantity,
            price: i.price,
            costPrice: i.costPrice,
            productId: i.productId,
          })),
        },
      },
    });
  } else {
    await prisma.order.create({
      data: {
        ...orderData,
        items: {
          create: itemsWithCost.map((i) => ({
            externalSku: i.externalSku,
            name: i.name,
            quantity: i.quantity,
            price: i.price,
            costPrice: i.costPrice,
            productId: i.productId,
          })),
        },
      },
    });
  }
}

export async function syncKaspiOrders(dateFrom: Date, dateTo: Date) {
  if (!(await kaspiClient.isConfigured())) {
    logger.warn('[Kaspi] Токен не задан в .env — синхронизация пропущена');
    return { ordersProcessed: 0 };
  }

  const log = await prisma.syncLog.create({
    data: { marketplace: 'KASPI', status: 'RUNNING' },
  });

  try {
    const orders = await kaspiClient.fetchOrders({ dateFrom, dateTo });
    for (const order of orders) {
      await persistOrder(order);
    }
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS', ordersProcessed: orders.length, finishedAt: new Date() },
    });
    return { ordersProcessed: orders.length };
  } catch (err: any) {
    logger.error({ err }, '[Kaspi] Ошибка синхронизации');
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'ERROR', message: String(err?.message ?? err), finishedAt: new Date() },
    });
    throw err;
  }
}

export async function syncOzonOrders(dateFrom: Date, dateTo: Date) {
  if (!ozonClient.isConfigured) {
    logger.warn('[Ozon] Client-Id/Api-Key не заданы в .env — синхронизация пропущена');
    return { ordersProcessed: 0 };
  }

  const log = await prisma.syncLog.create({
    data: { marketplace: 'OZON', status: 'RUNNING' },
  });

  try {
    const orders = await ozonClient.fetchOrders({ dateFrom, dateTo });
    for (const order of orders) {
      await persistOrder(order);
    }
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS', ordersProcessed: orders.length, finishedAt: new Date() },
    });
    return { ordersProcessed: orders.length };
  } catch (err: any) {
    logger.error({ err }, '[Ozon] Ошибка синхронизации');
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'ERROR', message: String(err?.message ?? err), finishedAt: new Date() },
    });
    throw err;
  }
}

export async function syncWbOrders(dateFrom: Date, dateTo: Date) {
  if (!wbClient.isConfigured) {
    logger.warn('[Wildberries] Токен не задан в .env — синхронизация пропущена');
    return { ordersProcessed: 0 };
  }

  const log = await prisma.syncLog.create({
    data: { marketplace: 'WB', status: 'RUNNING' },
  });

  try {
    const orders = await wbClient.fetchOrders({ dateFrom, dateTo });
    for (const order of orders) {
      await persistOrder(order);
    }
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS', ordersProcessed: orders.length, finishedAt: new Date() },
    });
    return { ordersProcessed: orders.length };
  } catch (err: any) {
    logger.error({ err }, '[Wildberries] Ошибка синхронизации');
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'ERROR', message: String(err?.message ?? err), finishedAt: new Date() },
    });
    throw err;
  }
}
