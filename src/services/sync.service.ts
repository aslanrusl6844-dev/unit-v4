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
  kaspiLeafCategoryFromApi?: string,
  weightGFromApi?: number,
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
          // Категория и вес — если Kaspi прислал их в данных заказа (см.
          // fetchEntryDetail в kaspi.client.ts), заполняем сразу, чтобы
          // комиссия считалась правильно с первой же синхронизации, а не
          // висела "нет категории" до ручного заполнения.
          ...(kaspiLeafCategoryFromApi ? { kaspiLeafCategory: kaspiLeafCategoryFromApi } : {}),
          ...(weightGFromApi ? { weightKg: round2(weightGFromApi / 1000) } : {}),
        },
      });
      stats.productsCreated += 1;
      logger.info(`[Каталог] Автоматически создан товар из заказа: ${created.name} (${marketplace} ${externalSku})`);
      return {
        productId: created.id,
        costPrice: 0,
        weightKg: created.weightKg,
        kaspiTopCategory: created.kaspiTopCategory ?? undefined,
        kaspiLeafCategory: created.kaspiLeafCategory ?? undefined,
      };
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
  // То же самое — для категории/веса: заполняем, только если у товара их
  // ЕЩЁ НЕТ (не перезаписываем то, что пользователь мог указать вручную).
  const updateData: Record<string, any> = {};
  if (itemName && itemName.trim() && (product.name.startsWith('Kaspi-товар') || product.name === 'Товар без названия')) {
    updateData.name = itemName.trim();
  }
  if (kaspiLeafCategoryFromApi && !product.kaspiLeafCategory) {
    updateData.kaspiLeafCategory = kaspiLeafCategoryFromApi;
  }
  if (weightGFromApi && (!product.weightKg || product.weightKg === 0.5)) {
    updateData.weightKg = round2(weightGFromApi / 1000);
  }
  if (Object.keys(updateData).length > 0) {
    await prisma.product.update({ where: { id: product.id }, data: updateData });
  }

  return {
    productId: product.id,
    costPrice: product.costPrice + product.packagingCost,
    weightKg: updateData.weightKg ?? product.weightKg,
    kaspiTopCategory: product.kaspiTopCategory ?? undefined,
    kaspiLeafCategory: updateData.kaspiLeafCategory ?? product.kaspiLeafCategory ?? undefined,
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

  // Шаг 1: точная комиссия каждой позиции по СВОЕЙ категории. Если верхняя
  // категория не указана — НЕ считаем комиссию нулевой (раньше было так,
  // это искажало отчёт в лучшую сторону сильнее, чем безопасный дефолт).
  // calcKaspiCommissionAmount сама подберёт точную ставку по leaf-категории
  // (если она известна из данных заказа Kaspi) или применит безопасный
  // дефолт 12.5% — это ставка у подавляющего большинства категорий Kaspi.
  const perItemCommission = itemsWithInfo.map((item) => {
    const itemRevenue = item.price * item.quantity;
    totalWeight += item.weightKg * item.quantity;

    const commission = calcKaspiCommissionAmount(itemRevenue, {
      topCategory: item.kaspiTopCategory ?? '',
      leafCategory: item.kaspiLeafCategory,
    });
    marketplaceCommission += commission;
    return commission;
  });

  // Логистика — тариф Kaspi Доставки, считаем ВСЕГДА (как и в прогнозе на
  // странице «Товары», см. getProductForecasts в analytics.service.ts).
  // Раньше здесь была проверка order.kaspiDelivery — но это поле ненадёжно
  // приходит от Kaspi (часто пусто даже для настоящих доставок Kaspi
  // Доставкой), из-за чего логистика в реальных продажах тихо обнулялась,
  // хотя для того же товара в прогнозе каталога считалась верно. Теперь
  // расчёт идентичен в обоих местах — прогноз и факт больше не расходятся.
  const logisticsCost = calculateKaspiDeliveryCost(order.totalRevenue, totalWeight, env.kaspi.defaultDeliveryZone);

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
      const info = await resolveProductInfo(order.marketplace, item.externalSku, item.name, stats, item.kaspiLeafCategory, item.weightG);
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

  // Обновляем "референсную" цену товара — ОТДЕЛЬНО для той площадки, на
  // которой случился этот заказ (у Kaspi/Ozon/WB своя цена и свои поля).
  // Обновляем только если ЭТОТ заказ новее, чем то, что уже сохранено по
  // этой конкретной площадке — иначе досинхронизация старых периодов
  // могла бы затереть свежую цену устаревшей.
  for (const item of itemsWithCost) {
    if (!item.productId) continue;
    const product = await prisma.product.findUnique({ where: { id: item.productId } });
    if (!product) continue;

    let updateData: Record<string, any> | null = null;
    if (order.marketplace === 'KASPI' && (!product.kaspiReferencePriceUpdatedAt || order.orderDate > product.kaspiReferencePriceUpdatedAt)) {
      updateData = { kaspiReferencePrice: item.price, kaspiReferencePriceUpdatedAt: order.orderDate };
    } else if (order.marketplace === 'OZON' && (!product.ozonReferencePriceUpdatedAt || order.orderDate > product.ozonReferencePriceUpdatedAt)) {
      updateData = { ozonReferencePrice: item.price, ozonReferencePriceUpdatedAt: order.orderDate };
    } else if (order.marketplace === 'WB' && (!product.wbReferencePriceUpdatedAt || order.orderDate > product.wbReferencePriceUpdatedAt)) {
      updateData = { wbReferencePrice: item.price, wbReferencePriceUpdatedAt: order.orderDate };
    }

    if (updateData) {
      await prisma.product.update({ where: { id: item.productId }, data: updateData });
    }
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
  if (!(await wbClient.isConfigured())) {
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

/**
 * Синхронизация КАТАЛОГА (не заказов) — подтягивает список товаров,
 * которые СЕЙЧАС стоят на продаже на площадке, через собственный API
 * площадки "список товаров" (не через историю заказов). Создаёт новые
 * товары (себестоимость 0 — обязательно проставить вручную) и обновляет
 * название/статус активности уже существующих, НЕ трогая себестоимость,
 * которую пользователь мог уже проставить.
 */
export async function syncOzonCatalog() {
  if (!(await ozonClient.isConfigured())) {
    logger.warn('[Ozon] Магазин не настроен — синхронизация каталога пропущена');
    return { created: 0, updated: 0 };
  }

  const catalog = await ozonClient.fetchCatalog();
<<<<<<< HEAD
  // Тарифы (комиссия/логистика) — отдельный запрос по всем найденным
  // offer_id разом, чтобы не делать по одному запросу на каждый товар.
  const prices = await ozonClient.fetchPrices(catalog.map((item) => item.offerId));

=======
>>>>>>> e8486ef7f59a6dd0d6c494f5cde8fdb3434200ca
  let created = 0;
  let updated = 0;

  for (const item of catalog) {
<<<<<<< HEAD
    const tariff = prices.get(item.offerId);
    const tariffData = tariff
      ? {
          ozonCommissionRatePct: tariff.commissionRatePct ?? null,
          ozonLogisticsAmount: tariff.logisticsAmount ?? null,
          ozonLastMileAmount: tariff.lastMileAmount ?? null,
          ozonReturnLogisticsAmount: tariff.returnLogisticsAmount ?? null,
          ozonAcquiringAmount: tariff.acquiringAmount ?? null,
          ozonTariffsUpdatedAt: new Date(),
        }
      : {};
    // Цена: приоритет — живая цена из /v5/product/info/prices (точнее и
    // свежее, чем то, что вернул /v3/product/info/list в fetchCatalog).
    const referencePrice = tariff?.price ?? item.price;

=======
>>>>>>> e8486ef7f59a6dd0d6c494f5cde8fdb3434200ca
    const existing = await prisma.product.findFirst({ where: { ozonOfferId: item.offerId } });
    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          active: item.active,
          // Название обновляем, только если сейчас placeholder — реальное
          // ручное название пользователя не затираем.
          ...(existing.name.startsWith('Ozon-товар') ? { name: item.name } : {}),
          // Живая цена из API Ozon — самая надёжная referencePrice, какая
          // у нас есть (точнее, чем цена последней продажи, которая могла
          // устареть). Обновляем её всегда, если Ozon её прислал.
<<<<<<< HEAD
          ...(referencePrice ? { ozonReferencePrice: referencePrice, ozonReferencePriceUpdatedAt: new Date() } : {}),
          ...tariffData,
=======
          ...(item.price ? { ozonReferencePrice: item.price, ozonReferencePriceUpdatedAt: new Date() } : {}),
>>>>>>> e8486ef7f59a6dd0d6c494f5cde8fdb3434200ca
        },
      });
      updated += 1;
    } else {
      await prisma.product.create({
        data: {
          sku: `ozon-${item.offerId}`,
          name: item.name,
          costPrice: 0,
          ozonOfferId: item.offerId,
          active: item.active,
<<<<<<< HEAD
          ...(referencePrice ? { ozonReferencePrice: referencePrice, ozonReferencePriceUpdatedAt: new Date() } : {}),
          ...tariffData,
=======
          ...(item.price ? { ozonReferencePrice: item.price, ozonReferencePriceUpdatedAt: new Date() } : {}),
>>>>>>> e8486ef7f59a6dd0d6c494f5cde8fdb3434200ca
        },
      });
      created += 1;
    }
  }

<<<<<<< HEAD
  logger.info(`[Ozon] Каталог синхронизирован: создано ${created}, обновлено ${updated}, тарифы получены для ${prices.size} товаров`);
=======
  logger.info(`[Ozon] Каталог синхронизирован: создано ${created}, обновлено ${updated}`);
>>>>>>> e8486ef7f59a6dd0d6c494f5cde8fdb3434200ca
  return { created, updated };
}

export async function syncWbCatalog() {
  if (!(await wbClient.isConfigured())) {
    logger.warn('[Wildberries] Токен не задан — синхронизация каталога пропущена');
    return { created: 0, updated: 0 };
  }

  const catalog = await wbClient.fetchCatalog();
  let created = 0;
  let updated = 0;

  for (const item of catalog) {
    const existing = await prisma.product.findFirst({ where: { wbArticle: item.vendorCode } });
    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          wbNmId: item.nmId,
          ...(existing.name.startsWith('WB-товар') ? { name: item.name } : {}),
        },
      });
      updated += 1;
    } else {
      await prisma.product.create({
        data: {
          sku: `wb-${item.vendorCode}`,
          name: item.name,
          costPrice: 0,
          wbArticle: item.vendorCode,
          wbNmId: item.nmId,
        },
      });
      created += 1;
    }
  }

  logger.info(`[Wildberries] Каталог синхронизирован: создано ${created}, обновлено ${updated}`);
  return { created, updated };
}
