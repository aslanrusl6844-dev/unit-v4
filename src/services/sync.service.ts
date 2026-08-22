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

async function resolveProductInfo(
  marketplace: MarketplaceName,
  externalSku: string,
  itemName: string,
  stats: { productsCreated: number },
): Promise<ResolvedProductInfo> {
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
    //
    // Название: если Kaspi не смог отдать нормальное название товара (см.
    // src/integrations/kaspi.client.ts — там отдельный запрос за названием
    // по каждой позиции), НЕ пишем одинаковое "Товар без названия" для всех —
    // используем сам SKU/артикул, так хотя бы можно отличить товары друг от
    // друга в каталоге до того, как вручную поправишь название.
    const resolvedName = itemName && itemName.trim() ? itemName.trim() : `Kaspi-товар ${externalSku}`;
    try {
      const created = await prisma.product.create({
        data: {
          sku: `${marketplace.toLowerCase()}-${externalSku}`,
          name: resolvedName,
          costPrice: 0,
          ...(marketplace === 'KASPI' ? { kaspiSku: externalSku } : {}),
          ...(marketplace === 'OZON' ? { ozonOfferId: externalSku } : {}),
          ...(marketplace === 'WB' ? { wbArticle: externalSku } : {}),
        },
      });
      stats.productsCreated += 1;
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

  // Если товар уже был создан автоматически БЕЗ нормального названия
  // (плейсхолдер "Kaspi-товар ..." или старое "Товар без названия"), а
  // сейчас пришло настоящее название — подтягиваем его, чтобы каталог
  // сам собой становился читаемее по мере повторных синхронизаций.
  if (
    itemName &&
    itemName.trim() &&
    (product.name.startsWith('Kaspi-товар') || product.name === 'Товар без названия')
  ) {
    await prisma.product.update({ where: { id: product.id }, data: { name: itemName.trim() } });
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
 * суммы/веса заказа) — сам API Kaspi эти суммы не отдаёт.
 *
 * Возвращает и итоги по заказу (для Order), и точную разбивку по каждой
 * позиции (для OrderItem) — это и есть «точный разнос», а не восстановление
 * задним числом через пропорцию от суммы заказа.
 */
function enrichKaspiFinancials(
  order: NormalizedOrder,
  itemsWithInfo: Array<{ price: number; quantity: number; weightKg: number; kaspiTopCategory?: string; kaspiLeafCategory?: string }>,
): { marketplaceCommission: number; logisticsCost: number; perItem: Array<{ commission: number; itemLogistics: number }> } {
  let marketplaceCommission = 0;
  let totalWeight = 0;

  // Шаг 1: точная комиссия каждой позиции по СВОЕЙ категории.
  const perItemCommission = itemsWithInfo.map((item) => {
    const itemRevenue = item.price * item.quantity;
    totalWeight += item.weightKg * item.quantity;

    if (!item.kaspiTopCategory) {
      // Категория не указана в карточке товара — комиссия для этой позиции
      // не считается (0), чтобы не искажать отчёт неверной ставкой.
      // Заполните kaspiTopCategory в разделе «Товары».
      return 0;
    }
    const commission = calcKaspiCommissionAmount(itemRevenue, {
      topCategory: item.kaspiTopCategory,
      leafCategory: item.kaspiLeafCategory,
    });
    marketplaceCommission += commission;
    return commission;
  });

  const logisticsCost = order.kaspiDelivery
    ? calculateKaspiDeliveryCost(order.totalRevenue, totalWeight, env.kaspi.defaultDeliveryZone)
    : 0;

  // Шаг 2: логистика заказа делится между позициями ПО ВЕСУ (не по цене) —
  // тариф Kaspi Доставки зависит от веса посылки, поэтому это точнее, чем
  // пропорция от выручки.
  const perItem = itemsWithInfo.map((item, i) => {
    const itemWeight = item.weightKg * item.quantity;
    const weightShare = totalWeight > 0 ? itemWeight / totalWeight : 1 / itemsWithInfo.length;
    return {
      commission: perItemCommission[i],
      itemLogistics: logisticsCost * weightShare,
    };
  });

  return { marketplaceCommission, logisticsCost, perItem };
}

async function persistOrder(order: NormalizedOrder, stats: { productsCreated: number }): Promise<void> {
  const itemsWithCost = await Promise.all(
    order.items.map(async (item) => {
      const info = await resolveProductInfo(order.marketplace, item.externalSku, item.name, stats);
      return { ...item, ...info };
    }),
  );

  const existing = await prisma.order.findUnique({
    where: { marketplace_externalId: { marketplace: order.marketplace, externalId: order.externalId } },
  });

  let { marketplaceCommission, logisticsCost } = order;
  // perItemFinancials[i] соответствует itemsWithCost[i] — точная комиссия и
  // логистика КОНКРЕТНО этой позиции (не восстановленная задним числом).
  let perItemFinancials: Array<{ commission: number; itemLogistics: number }>;

  if (order.marketplace === 'KASPI') {
    const kaspiFinancials = enrichKaspiFinancials(order, itemsWithCost);
    marketplaceCommission = kaspiFinancials.marketplaceCommission;
    logisticsCost = kaspiFinancials.logisticsCost;
    perItemFinancials = kaspiFinancials.perItem;
  } else {
    // Ozon/WB: комиссия площадки — процент от цены (не зависит от категории
    // так резко, как у Kaspi), поэтому распределение по доле выручки внутри
    // заказа даёт точный результат (для WB это вообще 1-в-1, т.к. там один
    // заказ = один товар — см. src/integrations/wb.client.ts).
    const orderRevenue = itemsWithCost.reduce((s, i) => s + i.price * i.quantity, 0);
    perItemFinancials = itemsWithCost.map((item) => {
      const share = orderRevenue > 0 ? (item.price * item.quantity) / orderRevenue : 1 / itemsWithCost.length;
      return { commission: marketplaceCommission * share, itemLogistics: logisticsCost * share };
    });
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

  const itemsCreateData = itemsWithCost.map((i, idx) => ({
    externalSku: i.externalSku,
    name: i.name,
    quantity: i.quantity,
    price: i.price,
    costPrice: i.costPrice,
    productId: i.productId,
    commission: round2(perItemFinancials[idx].commission),
    itemLogistics: round2(perItemFinancials[idx].itemLogistics),
  }));

  if (existing) {
    await prisma.orderItem.deleteMany({ where: { orderId: existing.id } });
    await prisma.order.update({
      where: { id: existing.id },
      data: { ...orderData, items: { create: itemsCreateData } },
    });
  } else {
    await prisma.order.create({
      data: { ...orderData, items: { create: itemsCreateData } },
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function syncKaspiOrders(dateFrom: Date, dateTo: Date) {
  if (!(await kaspiClient.isConfigured())) {
    logger.warn('[Kaspi] Токен не задан в .env — синхронизация пропущена');
    return { ordersProcessed: 0, productsCreated: 0 };
  }

  const log = await prisma.syncLog.create({
    data: { marketplace: 'KASPI', status: 'RUNNING' },
  });

  const stats = { productsCreated: 0 };
  try {
    const orders = await kaspiClient.fetchOrders({ dateFrom, dateTo });
    for (const order of orders) {
      await persistOrder(order, stats);
    }
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS', ordersProcessed: orders.length, finishedAt: new Date() },
    });
    return { ordersProcessed: orders.length, productsCreated: stats.productsCreated };
  } catch (err: any) {
    logger.error({ err }, '[Kaspi] Ошибка синхронизации');
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'ERROR', message: String(err?.message ?? err), finishedAt: new Date(), ordersProcessed: 0 },
    });
    throw err;
  }
}

export async function syncOzonOrders(dateFrom: Date, dateTo: Date) {
  if (!(await ozonClient.isConfigured())) {
    logger.warn('[Ozon] Client-Id/Api-Key не заданы в .env — синхронизация пропущена');
    return { ordersProcessed: 0, productsCreated: 0 };
  }

  const log = await prisma.syncLog.create({
    data: { marketplace: 'OZON', status: 'RUNNING' },
  });

  const stats = { productsCreated: 0 };
  try {
    const orders = await ozonClient.fetchOrders({ dateFrom, dateTo });
    for (const order of orders) {
      await persistOrder(order, stats);
    }
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS', ordersProcessed: orders.length, finishedAt: new Date() },
    });
    return { ordersProcessed: orders.length, productsCreated: stats.productsCreated };
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
    return { ordersProcessed: 0, productsCreated: 0 };
  }

  const log = await prisma.syncLog.create({
    data: { marketplace: 'WB', status: 'RUNNING' },
  });

  const stats = { productsCreated: 0 };
  try {
    const orders = await wbClient.fetchOrders({ dateFrom, dateTo });
    for (const order of orders) {
      await persistOrder(order, stats);
    }
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS', ordersProcessed: orders.length, finishedAt: new Date() },
    });
    return { ordersProcessed: orders.length, productsCreated: stats.productsCreated };
  } catch (err: any) {
    logger.error({ err }, '[Wildberries] Ошибка синхронизации');
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: 'ERROR', message: String(err?.message ?? err), finishedAt: new Date() },
    });
    throw err;
  }
}
