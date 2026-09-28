import { prisma } from '../db/prisma';
import { kaspiClient } from '../integrations/kaspi.client';
import { ozonClient } from '../integrations/ozon.client';
import { wbClient } from '../integrations/wb.client';
import { fetchProductImages } from '../integrations/kaspi.scraper';
import { looksLikeAttributeDump, looksLikeLegacySyncDump, buildCharacteristics } from '../integrations/ozon.content';
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
  wbSubjectFromApi?: string,
  wbSchemeFromApi?: 'FBS' | 'FBW',
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
          // "Предмет" WB и схема (FBS/FBW) — для точного расчёта комиссии по
          // справочнику (см. src/integrations/wb.categories.ts).
          ...(wbSubjectFromApi ? { wbSubject: wbSubjectFromApi } : {}),
          ...(wbSchemeFromApi ? { wbScheme: wbSchemeFromApi } : {}),
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
  if (wbSubjectFromApi && !product.wbSubject) {
    updateData.wbSubject = wbSubjectFromApi;
  }
  // Схему (FBS/FBW) обновляем ВСЕГДА при новом заказе (не только если её
  // раньше не было) — в отличие от категории/веса, схема продажи товара
  // МОЖЕТ меняться со временем (продавец может переключить FBS/FBW), и
  // последний заказ — самый достоверный источник актуальной схемы.
  if (wbSchemeFromApi) {
    updateData.wbScheme = wbSchemeFromApi;
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
      const info = await resolveProductInfo(order.marketplace, item.externalSku, item.name, stats, item.kaspiLeafCategory, item.weightG, item.wbSubject, item.wbScheme);
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
  // Тарифы (комиссия/логистика) — отдельный запрос по всем найденным
  // offer_id разом, чтобы не делать по одному запросу на каждый товар.
  const prices = await ozonClient.fetchPrices(catalog.map((item) => item.offerId));

  let created = 0;
  let updated = 0;

  for (const item of catalog) {
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
          ...(referencePrice ? { ozonReferencePrice: referencePrice, ozonReferencePriceUpdatedAt: new Date() } : {}),
          ...tariffData,
          // Фото с площадки — в отдельное поле marketImages (не в images
          // витрины, её фото не трогаем). Если Ozon фото не прислал —
          // прежнее значение не стираем.
          ...(item.images.length
            ? {
                marketImages: JSON.stringify(item.images),
                // Если images витрины — это нетронутая копия прежних фото Ozon
                // (руками их не меняли), обновляем и её; свои фото не трогаем.
                ...(existing.images && existing.images === existing.marketImages ? { images: JSON.stringify(item.images) } : {}),
              }
            : {}),
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
          ...(referencePrice ? { ozonReferencePrice: referencePrice, ozonReferencePriceUpdatedAt: new Date() } : {}),
          ...tariffData,
          ...(item.images.length ? { marketImages: JSON.stringify(item.images) } : {}),
        },
      });
      created += 1;
    }
  }

  logger.info(`[Ozon] Каталог синхронизирован: создано ${created}, обновлено ${updated}, тарифы получены для ${prices.size} товаров`);
  return { created, updated };
}

export async function syncWbCatalog() {
  if (!(await wbClient.isConfigured())) {
    logger.warn('[Wildberries] Токен не задан — синхронизация каталога пропущена');
    return { created: 0, updated: 0 };
  }

  const catalog = await wbClient.fetchCatalog();
  // Живые цены — отдельный запрос по всем товарам разом (см. fetchPrices
  // в wb.client.ts). Без этого поле "Цена" остаётся пустым для товаров,
  // по которым ещё не было ни одной продажи — а без цены прогноз
  // юнит-экономики не может посчитать вообще ничего, даже если справочник
  // комиссий работает правильно.
  let prices = new Map<number, number>();
  let priceError: string | null = null;
  try {
    prices = await wbClient.fetchPrices();
  } catch (err: any) {
    // Не роняем всю синхронизацию каталога, если именно цены не удалось
    // получить (например, у токена нет категории доступа "Цены и скидки") —
    // каталог (названия/предметы) всё равно стоит сохранить. Но саму
    // причину обязательно возвращаем наружу — иначе пользователь видит
    // "обновлено N товаров" и не понимает, почему цена всё равно пустая.
    priceError = String(err?.message ?? err);
    logger.warn({ err: priceError }, '[Wildberries] Не удалось получить цены — каталог синхронизируется без них');
  }

  let created = 0;
  let updated = 0;
  let subjectMissingCount = 0;

  for (const item of catalog) {
    const price = prices.get(item.nmId);
    if (!item.subject) subjectMissingCount += 1;
    const existing = await prisma.product.findFirst({ where: { wbArticle: item.vendorCode } });
    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          wbNmId: item.nmId,
          ...(existing.name.startsWith('WB-товар') ? { name: item.name } : {}),
          // "Предмет" — только если его ещё нет (не перезатираем то, что
          // могло прийти точнее из данных заказа).
          ...(item.subject && !existing.wbSubject ? { wbSubject: item.subject } : {}),
          // Живая цена — обновляем всегда, если WB её прислал (это самая
          // надёжная referencePrice для WB, точнее устаревшей цены
          // последней продажи).
          ...(price != null ? { wbReferencePrice: price, wbReferencePriceUpdatedAt: new Date() } : {}),
          // Фото с площадки — в marketImages, не в images витрины; если WB
          // фото не прислал — прежнее значение не стираем.
          ...(item.images.length ? { marketImages: JSON.stringify(item.images) } : {}),
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
          ...(item.subject ? { wbSubject: item.subject } : {}),
          ...(price != null ? { wbReferencePrice: price, wbReferencePriceUpdatedAt: new Date() } : {}),
          ...(item.images.length ? { marketImages: JSON.stringify(item.images) } : {}),
        },
      });
      created += 1;
    }
  }

  logger.info(`[Wildberries] Каталог синхронизирован: создано ${created}, обновлено ${updated}, цены получены для ${prices.size} товаров, предмет не пришёл у ${subjectMissingCount}`);
  return {
    created,
    updated,
    pricesFetched: prices.size,
    priceError,
    subjectMissingCount,
  };
}

/**
 * Фото Kaspi для товаров учёта — ПАЧКОЙ (по умолчанию 5 за вызов, чтобы
 * уложиться в лимит serverless-функции). Официальный API Kaspi фото не
 * отдаёт, поэтому читаем публичную страницу товара по kaspiProductUrl
 * (см. fetchProductImages). Товары без kaspiProductUrl пропускаются (ссылку
 * не угадываем) — их число возвращается в withoutUrl. Только чтение: на
 * Kaspi ничего не меняется. Проверенные товары помечаются marketImages
 * ("[]" = страница открылась, фото нет), чтобы не проверять их снова;
 * товары, чью страницу прочитать не удалось, остаются непроверенными.
 */
export async function syncKaspiPhotos(limit = 5, excludeIds: string[] = []) {
  // excludeIds — товары, чью страницу не удалось прочитать в ЭТОМ запуске
  // (их передаёт фронт): без исключения они оставались бы "непроверенными"
  // и каждый вызов снова упирался бы в одни и те же первые товары.
  const where = {
    kaspiSku: { not: null },
    kaspiProductUrl: { not: null },
    NOT: { kaspiProductUrl: '' },
    marketImages: null,
    ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
  };
  const batch = await prisma.product.findMany({ where, take: limit, orderBy: { id: 'asc' }, select: { id: true, kaspiProductUrl: true } });

  let withPhotos = 0;
  const failedIds: string[] = [];
  await Promise.all(
    batch.map(async (p: { id: string; kaspiProductUrl: string | null }) => {
      const images = await fetchProductImages(p.kaspiProductUrl as string);
      if (images === null) {
        failedIds.push(p.id);
        return;
      }
      await prisma.product.update({ where: { id: p.id }, data: { marketImages: JSON.stringify(images) } });
      if (images.length) withPhotos += 1;
    }),
  );

  const remainingWhere = { ...where, id: { notIn: [...excludeIds, ...failedIds] } };
  const remaining = await prisma.product.count({ where: remainingWhere });
  const withoutUrl = await prisma.product.count({
    where: { kaspiSku: { not: null }, OR: [{ kaspiProductUrl: null }, { kaspiProductUrl: '' }], marketImages: null },
  });
  logger.info(`[Kaspi] Фото: проверено ${batch.length}, с фото ${withPhotos}, не удалось прочитать ${failedIds.length}, осталось ${remaining}, без ссылки ${withoutUrl}`);
  return { checked: batch.length, withPhotos, failedIds, remaining, withoutUrl };
}

/** Ключ словаря: тип Ozon без учёта регистра и лишних пробелов. */
export function ozonTypeKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Описание, состав/характеристики, фото и категория для КАРТОЧЕК My Market из
 * данных Ozon — только для товаров, которые уже есть в базе (по ozonOfferId).
 * Пачками (по умолчанию 40) с курсором, чтобы уложиться в лимит serverless.
 *
 * Правила (см. ТЗ):
 *  - description / composition пишутся, если поле пустое или его раньше
 *    записал этот же синк (*Source = "ozon"); поле, которое правили руками,
 *    не трогаем;
 *  - images витрины — только если поле пустое, из marketImages (фото Ozon);
 *  - category/type — ТОЛЬКО через словарь OzonTypeMap по типу Ozon. Нет записи
 *    в словаре — остаются пустыми. Тип по названию не угадываем, сырую
 *    категорию Ozon не пишем;
 *  - shopActive, shopPrice, shopStock, subcategory не трогаются вообще.
 */
export async function syncOzonContent(limit = 40, cursor?: string) {
  if (!(await ozonClient.isConfigured())) {
    logger.warn('[Ozon] Магазин не настроен — синхронизация описаний пропущена');
    return { processed: 0, updated: 0, withDescription: 0, mapped: 0, unmappedTypes: [] as string[], nextCursor: null as string | null, done: true };
  }

  const products = await prisma.product.findMany({
    where: { ozonOfferId: { not: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' },
    take: limit,
    select: {
      id: true, ozonOfferId: true, description: true, composition: true, descriptionSource: true, compositionSource: true,
      images: true, marketImages: true, category: true, type: true, categorySource: true, ozonType: true, characteristics: true,
    },
  });
  if (!products.length) return { processed: 0, updated: 0, withDescription: 0, mapped: 0, unmappedTypes: [] as string[], nextCursor: null as string | null, done: true };

  const content = await ozonClient.fetchProductContent(products.map((p: { ozonOfferId: string | null }) => p.ozonOfferId as string));
  const byOffer = new Map(content.map((c) => [c.offerId, c]));
  const dictRows = await prisma.ozonTypeMap.findMany();
  const dict = new Map<string, { category: string; type: string }>(dictRows.map((r: { ozonTypeKey: string; category: string; type: string }) => [r.ozonTypeKey, { category: r.category, type: r.type }]));

  let updated = 0;
  let withDescription = 0;
  let mapped = 0;
  const unmapped = new Set<string>();

  for (const p of products) {
    const c = byOffer.get(p.ozonOfferId as string);
    if (!c) continue;
    const data: Record<string, unknown> = {};

    if (c.typeName && c.typeName !== p.ozonType) data.ozonType = c.typeName;

    // Описание — только очищенная аннотация (см. ozon.content.ts). Пишем в пустое
    // поле или в то, что раньше записал синк; вписанное руками не трогаем.
    if (c.description !== undefined) {
      if (c.description && (!p.description || p.descriptionSource === 'ozon')) {
        if (c.description !== p.description) data.description = c.description;
        data.descriptionSource = 'ozon';
      } else if (!c.description && p.descriptionSource === 'ozon' && p.description) {
        // Аннотация после чистки пуста (там была только оферта/хештеги) — а прежний
        // текст писал сам синк: убираем его, чтобы мусор не висел в карточке.
        data.description = null;
        data.descriptionSource = null;
      }
    }

    // Состав — ТОЛЬКО из отдельного поля Ozon «Состав»/«Состав/ингредиенты», чистым
    // текстом. Уже залитая свалка атрибутов («#Хештеги», «ТН ВЭД», «Нужен код
    // маркировки»…) очищается и, если у товара есть нормальный состав, тут же
    // заполняется заново. Вписанный руками состав не трогаем.
    let curComposition: string | null = p.composition;
    let curCompositionSource: string | null = p.compositionSource;
    const compositionIsDump =
      !!p.composition && (looksLikeAttributeDump(p.composition) || (p.compositionSource === 'ozon' && looksLikeLegacySyncDump(p.composition)));
    if (compositionIsDump) {
      data.composition = null;
      data.compositionSource = null;
      curComposition = null;
      curCompositionSource = null;
    }
    if (c.composition && (!curComposition || curCompositionSource === 'ozon')) {
      data.composition = c.composition;
      data.compositionSource = 'ozon';
    }

    // Короткий список для покупателя: Тип, Материал, Артикул. Считается заново
    // при каждом синке (это производные данные, вручную не правятся).
    const characteristicsJson = JSON.stringify(buildCharacteristics({ typeName: c.typeName ?? p.ozonType ?? undefined, material: c.material, offerId: p.ozonOfferId ?? undefined }));
    if (characteristicsJson !== p.characteristics) data.characteristics = characteristicsJson;
    if (p.descriptionSource === 'ozon' || data.descriptionSource === 'ozon') withDescription += 1;

    // Фото витрины: только если пусто (свои и скопированные ранее не трогаем).
    const imagesEmpty = !p.images || p.images === '[]';
    if (imagesEmpty && p.marketImages && p.marketImages !== '[]') data.images = p.marketImages;

    // Категория/тип — только из словаря; пусто у нас или проставлено словарём ранее.
    const typeName = c.typeName ?? p.ozonType ?? null;
    if (typeName) {
      const hit = dict.get(ozonTypeKey(typeName));
      const mayWrite = (!p.category && !p.type) || p.categorySource === 'dictionary';
      if (hit && mayWrite) {
        if (hit.category !== p.category) data.category = hit.category;
        if (hit.type !== p.type) data.type = hit.type;
        data.categorySource = 'dictionary';
        mapped += 1;
      } else if (!hit) {
        unmapped.add(typeName);
      }
    }

    // Обновляем только если реально что-то изменилось (источник без изменений — не пишем).
    const changed = Object.entries(data).some(([k, v]) => (p as Record<string, unknown>)[k] !== v);
    if (changed) {
      await prisma.product.update({ where: { id: p.id }, data });
      updated += 1;
    }
  }

  const last = products[products.length - 1].id as string;
  const done = products.length < limit;
  logger.info(`[Ozon] Описания: обработано ${products.length}, обновлено ${updated}, категория из словаря ${mapped}, типов без соответствия ${unmapped.size}`);
  return { processed: products.length, updated, withDescription, mapped, unmappedTypes: Array.from(unmapped), nextCursor: done ? null : last, done };
}

