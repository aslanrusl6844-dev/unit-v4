import { prisma } from '../db/prisma';

/** Случайное 7-значное число (1000000–9999999) — НЕ производная от sku/id
 *  площадки, просто случайное число нужной длины. */
export function randomShopArticleCandidate(): string {
  return String(Math.floor(1000000 + Math.random() * 9000000));
}

/**
 * Генерирует уникальный 7-значный артикул витрины: случайное число, при
 * занятом — новое (не max+1, никакой последовательности). Проверяет заняты
 * шопом уже сгенерированные значения; на практике коллизия почти невозможна
 * (9 млн вариантов), но код на неё рассчитан явно, а не понадеявшись.
 */
export async function generateUniqueShopArticle(maxAttempts = 30): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = randomShopArticleCandidate();
    const exists = await prisma.product.findUnique({ where: { shopArticle: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  throw new Error('Не удалось подобрать свободный артикул витрины за отведённое число попыток');
}

/**
 * Решает, нужно ли (впервые) сгенерировать артикул витрины для этого
 * сохранения, и если да — генерирует. Правило (см. задачу): генерируем
 * ОДИН раз — при первом сохранении карточки, где в итоге есть цена
 * витрины, ИЛИ при включении «В продаже» — и только если артикул ещё
 * пуст. Уже заполненный артикул НИКОГДА не перегенерируется.
 *
 * effectivePrice/effectiveActive — итоговые значения ПОСЛЕ применения этого
 * сохранения (data.поле, если оно передано, иначе то, что уже было у
 * товара) — так генерация срабатывает и когда цена только что появилась, и
 * когда она уже стояла раньше, а сейчас просто пересохраняют другое поле.
 */
export async function maybeGenerateShopArticle(params: {
  currentShopArticle: string | null;
  effectivePrice: number | null | undefined;
  effectiveActive: boolean | null | undefined;
}): Promise<string | undefined> {
  if (params.currentShopArticle) return undefined; // уже есть — не трогаем
  const shouldGenerate = params.effectivePrice != null || params.effectiveActive === true;
  if (!shouldGenerate) return undefined;
  return generateUniqueShopArticle();
}
