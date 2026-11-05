/**
 * Баннеры главной приложения My Market (ShopBanner.slot):
 *  0..3 и 10..  — слайды большой карусели сверху (сколько угодно, до MAX_CAROUSEL_BANNERS);
 *  4    — «Реклама под витринами»: одна широкая полоса под рядом витрин (как у Coupang);
 *  5..9 — запас под другие особые полосы, в карусель не попадают.
 */
export const CAROUSEL_LAST_SLOT = 3; // первые четыре слайда, которые админка показывает всегда
export const UNDER_SHOWCASE_SLOT = 4;
export const RESERVED_SLOTS = [4, 5, 6, 7, 8, 9];
export const MAX_CAROUSEL_BANNERS = 30;

export function isCarouselSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < 1000 && !RESERVED_SLOTS.includes(slot);
}

/** Номер для нового слайда: следующий после последнего, особые слоты 4..9 пропускаем. */
export function nextCarouselSlot(used: number[]): number {
  const carousel = used.filter(isCarouselSlot);
  let next = carousel.length ? Math.max(...carousel) + 1 : 0;
  while (!isCarouselSlot(next)) next += 1;
  return next;
}

/** Рекомендуемый размер картинки полосы под витринами: 1080 × 250 пикселей (≈ 4,3 : 1). */
export const UNDER_SHOWCASE_IMAGE_HINT = '1080×250';

/** Переходы карусели баннеров (приложение рисует их само). */
export const BANNER_TRANSITIONS = ['slide', 'cube', 'fade', 'zoom', 'flip', 'depth', 'strips', 'deck', 'blinds', 'checker', 'mix'] as const;
export type BannerTransition = (typeof BANNER_TRANSITIONS)[number];
export function normalizeTransition(v: unknown): BannerTransition {
  return (BANNER_TRANSITIONS as readonly string[]).includes(String(v)) ? (v as BannerTransition) : 'slide';
}

/** Появление букв подписи на баннере витрин. */
export const CAPTION_EFFECTS = ['rise', 'bounce', 'flip3d', 'matrix'] as const;
export function normalizeCaption(v: unknown): string {
  return (CAPTION_EFFECTS as readonly string[]).includes(String(v)) ? String(v) : 'rise';
}
