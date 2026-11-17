"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KASPI_TOP_CATEGORY_RATE = exports.KASPI_RATE_DEFAULT = void 0;
exports.getKaspiCommissionRate = getKaspiCommissionRate;
exports.calcKaspiCommissionAmount = calcKaspiCommissionAmount;
exports.getAllKaspiCategoriesWithRates = getAllKaspiCategoriesWithRates;
const kaspiCategoryTariffs_json_1 = __importDefault(require("../data/kaspiCategoryTariffs.json"));
const kaspiCategoryTariffs = kaspiCategoryTariffs_json_1.default;
// Дефолт — если вообще ничего не известно о категории товара. Посчитан по
// реальным данным: 3881 из 4126 строк таблицы (94%) используют именно эту
// ставку — самая распространённая на площадке, безопасный выбор "по умолчанию".
exports.KASPI_RATE_DEFAULT = 12.5;
// Доминирующая (самая частая) ставка по каждой категории 1-го уровня —
// используется, когда известна ТОЛЬКО верхняя категория товара, без точной
// leaf-категории (5-го уровня). Посчитано из тех же 4126 строк реальной
// таблицы (мода — не выдумано вручную).
exports.KASPI_TOP_CATEGORY_RATE = {
    'Автотовары': 12.5,
    'Аксессуары': 15.5,
    'Аптека': 12.5,
    'Бытовая техника': 12.5,
    'Детские товары': 12.5,
    'Досуг, книги': 12.5,
    'Канцелярские товары': 12.5,
    'Компьютеры': 12.5,
    'Красота и здоровье': 12.5,
    'Мебель': 12.5,
    'Обувь': 12.5,
    'Одежда': 12.5,
    'Подарки, товары для праздников': 12.5,
    'Продукты питания': 7.3,
    'Спорт, туризм': 12.5,
    'Строительство, ремонт': 12.5,
    'ТВ, Аудио, Видео': 12.5,
    'Телефоны и гаджеты': 12.5,
    'Товары для дома и дачи': 12.5,
    'Товары для животных': 12.5,
    'Украшения': 15.5,
};
/**
 * Возвращает комиссию Kaspi (С УЧЁТОМ НДС, в %) для товара по его категории.
 * Приоритет:
 *   1) Точное совпадение leaf-категории в ПОЛНОЙ таблице (4113 категорий) —
 *      самый точный вариант, покрывает практически весь ассортимент Kaspi.
 *   2) Доминирующая ставка по категории 1-го уровня (если leaf неизвестен
 *      или не нашёлся в таблице).
 *   3) Безопасный дефолт 12.5% (самая частая ставка на площадке) — так
 *      комиссия НИКОГДА не считается нулевой, даже без единой известной категории.
 */
function getKaspiCommissionRate(input) {
    const { topCategory, leafCategory } = input;
    if (leafCategory && leafCategory in kaspiCategoryTariffs) {
        return kaspiCategoryTariffs[leafCategory].ratePct;
    }
    if (topCategory in exports.KASPI_TOP_CATEGORY_RATE) {
        return exports.KASPI_TOP_CATEGORY_RATE[topCategory];
    }
    return exports.KASPI_RATE_DEFAULT; // безопасный дефолт — комиссия никогда не 0
}
/**
 * Сумма комиссии в тенге для конкретной продажи. Ставка из
 * getKaspiCommissionRate() — это уже готовая ставка С НДС.
 */
function calcKaspiCommissionAmount(revenue, input) {
    const rate = getKaspiCommissionRate(input);
    return Math.round((revenue * rate) / 100 * 100) / 100;
}
/**
 * ПОЛНЫЙ список всех категорий Kaspi из официальной таблицы тарифов —
 * 4113 точных (5-го уровня) + 21 верхнего уровня. Ничего не выдумано —
 * ровно то, что есть в PDF пользователя, плюс безопасные дефолты по
 * верхним разделам (посчитаны как мода по реальным данным, не вручную).
 */
function getAllKaspiCategoriesWithRates() {
    const result = [];
    for (const [name, ratePct] of Object.entries(exports.KASPI_TOP_CATEGORY_RATE)) {
        result.push({ name, ratePct, level: 'top' });
    }
    for (const [name, entry] of Object.entries(kaspiCategoryTariffs)) {
        result.push({ name, ratePct: entry.ratePct, level: 'leaf', topCategory: entry.topCategory });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
//# sourceMappingURL=kaspi.categories.js.map