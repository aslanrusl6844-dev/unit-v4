"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHOP_CATEGORIES = void 0;
exports.normalizeShopCategory = normalizeShopCategory;
exports.isValidShopCategory = isValidShopCategory;
/**
 * Жёсткий список разделов витрины My Market. НЕ угадывается из дерева Ozon
 * и не расширяется автоматически «уже использованными» значениями (в
 * отличие от типов, category сюда не добавляется сама). Порядок — как в
 * задаче, это порядок показа в select. Тот же список (буквально, в том же
 * порядке) продублирован в public/dashboard.js (MM_SHOP_CATEGORIES) —
 * менять нужно оба сразу.
 */
exports.SHOP_CATEGORIES = [
    'Женская одежда',
    'Мужская одежда',
    'Детская одежда',
    'Обувь',
    'Ювелирные украшения',
    'Электроника',
    'Бытовая техника',
    'Красота и здоровье',
    'Дом и сад',
    'Мебель',
    'Аксессуары',
    'Строительство и ремонт',
    'Автотовары',
    'Продукты питания',
    'Товары для животных',
    'Детские товары',
    'Спорт и отдых',
    'Аптека',
    'Канцелярия',
    'Бытовая химия',
    'Транспортные средства',
    'Игры и консоли',
    'Туризм, охота и рыбалка',
];
const SHOP_CATEGORY_SET = new Set(exports.SHOP_CATEGORIES);
/**
 * Сверяет с каноническим списком ТОЧНО, без учёта регистра — «бытовая
 * техника» (нижний регистр) в задаче прямо названа тем же старым/неверным
 * значением, что и «украшение» и «Кухня», а не опечаткой, которую можно
 * само собой поправить. Терпим только к пробелам по краям (это форматирование,
 * не другое значение). Не из списка (или пусто) → null: не угадываем,
 * не подгоняем регистр — просто говорим "такого в списке нет".
 */
function normalizeShopCategory(raw) {
    if (!raw)
        return null;
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    return SHOP_CATEGORY_SET.has(trimmed) ? trimmed : null;
}
function isValidShopCategory(raw) {
    return normalizeShopCategory(raw) !== null;
}
//# sourceMappingURL=shopCategories.js.map