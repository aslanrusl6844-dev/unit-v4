"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAPTION_EFFECTS = exports.BANNER_TRANSITIONS = exports.UNDER_SHOWCASE_IMAGE_HINT = exports.MAX_CAROUSEL_BANNERS = exports.RESERVED_SLOTS = exports.UNDER_SHOWCASE_SLOT = exports.CAROUSEL_LAST_SLOT = void 0;
exports.isCarouselSlot = isCarouselSlot;
exports.nextCarouselSlot = nextCarouselSlot;
exports.normalizeTransition = normalizeTransition;
exports.normalizeCaption = normalizeCaption;
/**
 * Баннеры главной приложения My Market (ShopBanner.slot):
 *  0..3 и 10..  — слайды большой карусели сверху (сколько угодно, до MAX_CAROUSEL_BANNERS);
 *  4    — «Реклама под витринами»: одна широкая полоса под рядом витрин (как у Coupang);
 *  5..9 — запас под другие особые полосы, в карусель не попадают.
 */
exports.CAROUSEL_LAST_SLOT = 3; // первые четыре слайда, которые админка показывает всегда
exports.UNDER_SHOWCASE_SLOT = 4;
exports.RESERVED_SLOTS = [4, 5, 6, 7, 8, 9];
exports.MAX_CAROUSEL_BANNERS = 30;
function isCarouselSlot(slot) {
    return Number.isInteger(slot) && slot >= 0 && slot < 1000 && !exports.RESERVED_SLOTS.includes(slot);
}
/** Номер для нового слайда: следующий после последнего, особые слоты 4..9 пропускаем. */
function nextCarouselSlot(used) {
    const carousel = used.filter(isCarouselSlot);
    let next = carousel.length ? Math.max(...carousel) + 1 : 0;
    while (!isCarouselSlot(next))
        next += 1;
    return next;
}
/** Рекомендуемый размер картинки полосы под витринами: 1080 × 250 пикселей (≈ 4,3 : 1). */
exports.UNDER_SHOWCASE_IMAGE_HINT = '1080×250';
/** Переходы карусели баннеров (приложение рисует их само). */
exports.BANNER_TRANSITIONS = ['slide', 'cube', 'fade', 'zoom', 'flip', 'depth', 'strips', 'deck', 'blinds', 'checker', 'mix'];
function normalizeTransition(v) {
    return exports.BANNER_TRANSITIONS.includes(String(v)) ? v : 'slide';
}
/** Появление букв подписи на баннере витрин. */
exports.CAPTION_EFFECTS = ['rise', 'bounce', 'flip3d', 'matrix'];
function normalizeCaption(v) {
    return exports.CAPTION_EFFECTS.includes(String(v)) ? String(v) : 'rise';
}
//# sourceMappingURL=banners.js.map