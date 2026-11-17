/**
 * Баннеры главной приложения My Market (ShopBanner.slot):
 *  0..3 и 10..  — слайды большой карусели сверху (сколько угодно, до MAX_CAROUSEL_BANNERS);
 *  4    — «Реклама под витринами»: одна широкая полоса под рядом витрин (как у Coupang);
 *  5..9 — запас под другие особые полосы, в карусель не попадают.
 */
export declare const CAROUSEL_LAST_SLOT = 3;
export declare const UNDER_SHOWCASE_SLOT = 4;
export declare const RESERVED_SLOTS: number[];
export declare const MAX_CAROUSEL_BANNERS = 30;
export declare function isCarouselSlot(slot: number): boolean;
/** Номер для нового слайда: следующий после последнего, особые слоты 4..9 пропускаем. */
export declare function nextCarouselSlot(used: number[]): number;
/** Рекомендуемый размер картинки полосы под витринами: 1080 × 250 пикселей (≈ 4,3 : 1). */
export declare const UNDER_SHOWCASE_IMAGE_HINT = "1080\u00D7250";
/** Переходы карусели баннеров (приложение рисует их само). */
export declare const BANNER_TRANSITIONS: readonly ["slide", "cube", "fade", "zoom", "flip", "depth", "strips", "deck", "blinds", "checker", "mix"];
export type BannerTransition = (typeof BANNER_TRANSITIONS)[number];
export declare function normalizeTransition(v: unknown): BannerTransition;
/** Появление букв подписи на баннере витрин. */
export declare const CAPTION_EFFECTS: readonly ["rise", "bounce", "flip3d", "matrix"];
export declare function normalizeCaption(v: unknown): string;
