"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.randomShopArticleCandidate = randomShopArticleCandidate;
exports.generateUniqueShopArticle = generateUniqueShopArticle;
exports.maybeGenerateShopArticle = maybeGenerateShopArticle;
const prisma_1 = require("../db/prisma");
/** Случайное 7-значное число (1000000–9999999) — НЕ производная от sku/id
 *  площадки, просто случайное число нужной длины. */
function randomShopArticleCandidate() {
    return String(Math.floor(1000000 + Math.random() * 9000000));
}
/**
 * Генерирует уникальный 7-значный артикул витрины: случайное число, при
 * занятом — новое (не max+1, никакой последовательности). Проверяет заняты
 * шопом уже сгенерированные значения; на практике коллизия почти невозможна
 * (9 млн вариантов), но код на неё рассчитан явно, а не понадеявшись.
 */
async function generateUniqueShopArticle(maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = randomShopArticleCandidate();
        const exists = await prisma_1.prisma.product.findUnique({ where: { shopArticle: candidate }, select: { id: true } });
        if (!exists)
            return candidate;
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
async function maybeGenerateShopArticle(params) {
    if (params.currentShopArticle)
        return undefined; // уже есть — не трогаем
    const shouldGenerate = params.effectivePrice != null || params.effectiveActive === true;
    if (!shouldGenerate)
        return undefined;
    return generateUniqueShopArticle();
}
//# sourceMappingURL=shopArticle.js.map