/**
 * «Синхронизировать с Ozon» в My Market: товары Ozon, которых ещё НЕТ в My Market,
 * становятся карточками витрины — с фото, названием и ценой с Ozon. Категория/тип —
 * только по словарю «тип Ozon → My Market» (OzonTypeMap); нет записи — категория пустая,
 * товар попадает в «Без категории».
 *
 * Товары, которые уже есть в My Market, НЕ трогаются вообще (ни цена, ни фото, ни
 * категория, ни описание). «Уже в My Market» = у товара есть хоть что-то от витрины:
 * цена витрины, артикул витрины, «В продаже», архив витрины, остаток витрины или sku mm-….
 * (Категория, проставленная словарём при синке описаний, сама по себе не считается —
 * без цены такой товар в приложении всё равно не продаётся.)
 *
 * Новые карточки создаются выключенными («В продаже» = нет): дальше, как и раньше,
 * их включают кнопкой «В витрину». Работает пачками с курсором (лимит serverless).
 */
import { prisma } from '../db/prisma';
import { ozonClient } from '../integrations/ozon.client';
import { buildCharacteristics } from '../integrations/ozon.content';
import { generateUniqueShopArticle } from './shopArticle';
import { ozonTypeKey } from './sync.service';
import { logger } from '../utils/logger';

type Candidate = {
  id: string; name: string; ozonOfferId: string | null; ozonReferencePrice: number | null;
  images: string | null; marketImages: string | null; category: string | null; type: string | null;
  categorySource: string | null; description: string | null; descriptionSource: string | null;
  ozonType: string | null;
};

/** Условие «товара ещё нет в My Market» для запроса к базе. */
export const NOT_IN_MY_MARKET = {
  shopPrice: null,
  shopArticle: null,
  shopActive: false,
  shopArchived: false,
  shopStock: 0,
  NOT: { sku: { startsWith: 'mm-' } },
} as const;

export interface OzonImportResult {
  processed: number;
  added: number;
  addedWithoutCategory: number;
  skippedNoPrice: number;
  unmappedTypes: string[];
  nextCursor: string | null;
  done: boolean;
}

export async function importOzonToMyMarket(limit = 40, cursor?: string): Promise<OzonImportResult> {
  const empty: OzonImportResult = { processed: 0, added: 0, addedWithoutCategory: 0, skippedNoPrice: 0, unmappedTypes: [], nextCursor: null, done: true };
  if (!(await ozonClient.isConfigured())) {
    logger.warn('[Ozon → My Market] Ozon не настроен — пропуск');
    return empty;
  }

  const products: Candidate[] = await prisma.product.findMany({
    where: { ozonOfferId: { not: null }, active: true, ...NOT_IN_MY_MARKET, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' },
    take: limit,
    select: {
      id: true, name: true, ozonOfferId: true, ozonReferencePrice: true, images: true, marketImages: true,
      category: true, type: true, categorySource: true, description: true, descriptionSource: true, ozonType: true,
    },
  });
  if (!products.length) return empty;

  // Тип/описание/материал с Ozon — одним запросом на пачку. Сбой не мешает добавить
  // товар (просто без категории и описания).
  let content = new Map<string, Awaited<ReturnType<typeof ozonClient.fetchProductContent>>[number]>();
  try {
    const rows = await ozonClient.fetchProductContent(products.map((p) => p.ozonOfferId as string));
    content = new Map(rows.map((c) => [c.offerId, c]));
  } catch (err) {
    logger.warn({ err }, '[Ozon → My Market] описания Ozon не получены — добавляем без них');
  }
  const dictRows: Array<{ ozonTypeKey: string; category: string; type: string }> = await prisma.ozonTypeMap.findMany();
  const dict = new Map(dictRows.map((r) => [r.ozonTypeKey, { category: r.category, type: r.type }]));

  let added = 0;
  let addedWithoutCategory = 0;
  let skippedNoPrice = 0;
  const unmapped = new Set<string>();

  for (const p of products) {
    const price = p.ozonReferencePrice != null && p.ozonReferencePrice > 0 ? Math.round(p.ozonReferencePrice) : null;
    if (!price) { skippedNoPrice += 1; continue; }
    const c = content.get(p.ozonOfferId as string);
    const typeName = c?.typeName ?? p.ozonType ?? null;
    const shopArticle = await generateUniqueShopArticle();

    const data: Record<string, unknown> = {
      shopPrice: price,
      shopArticle,
      shopActive: false,
    };
    if (c?.typeName && c.typeName !== p.ozonType) data.ozonType = c.typeName;

    // Фото витрины — фото с Ozon, если своих нет.
    if ((!p.images || p.images === '[]') && p.marketImages && p.marketImages !== '[]') data.images = p.marketImages;

    // Категория/тип — только словарь; пустые или ранее проставленные словарём.
    let hasCategory = !!p.category;
    if (typeName) {
      const hit = dict.get(ozonTypeKey(typeName));
      if (hit && ((!p.category && !p.type) || p.categorySource === 'dictionary')) {
        data.category = hit.category;
        data.type = hit.type;
        data.categorySource = 'dictionary';
        hasCategory = true;
      } else if (!hit) {
        unmapped.add(typeName);
      }
    }

    // Описание — только если пусто (или его раньше записал синк Ozon).
    if (c?.description && (!p.description || p.descriptionSource === 'ozon')) {
      data.description = c.description;
      data.descriptionSource = 'ozon';
    }
    data.characteristics = JSON.stringify(buildCharacteristics({ typeName: typeName ?? undefined, material: c?.material, shopArticle }));

    // Защита от гонки: обновляем, только если товар всё ещё не в My Market.
    const r = await prisma.product.updateMany({ where: { id: p.id, ...NOT_IN_MY_MARKET }, data });
    if (r.count) {
      added += 1;
      if (!hasCategory) addedWithoutCategory += 1;
    }
  }

  const done = products.length < limit;
  const nextCursor = done ? null : products[products.length - 1].id;
  logger.info(`[Ozon → My Market] пачка ${products.length}: добавлено ${added} (без категории ${addedWithoutCategory}), без цены ${skippedNoPrice}`);
  return { processed: products.length, added, addedWithoutCategory, skippedNoPrice, unmappedTypes: Array.from(unmapped), nextCursor, done };
}
