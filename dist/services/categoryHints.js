"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STARTER_CATALOG = exports.HINT_RULES = void 0;
exports.hintCategoryByName = hintCategoryByName;
exports.starterCatalogPairs = starterCatalogPairs;
exports.hintRuleCatalogPairs = hintRuleCatalogPairs;
exports.buildCatalog = buildCatalog;
const shopCatalogCanon_1 = require("../config/shopCatalogCanon");
const FEMALE_MALE = { female: 'Женская одежда', male: 'Мужская одежда' };
exports.HINT_RULES = [
    // Одежда: категория зависит от пола в названии.
    { match: /джинс/, exclude: /джинсов/, type: 'Джинсы', category: FEMALE_MALE }, // «джинсовая куртка» — не джинсы
    { match: /пижам/, type: 'Пижамы', category: FEMALE_MALE },
    { match: /шорт/, type: 'Шорты', category: FEMALE_MALE },
    { match: /рубашк/, type: 'Рубашки', category: FEMALE_MALE },
    { match: /юбк/, type: 'Юбки', category: 'Женская одежда' },
    { match: /плать/, type: 'Платья', category: 'Женская одежда' },
    // Косметика
    { match: /шампун/, type: 'Шампунь', category: 'Красота и здоровье' }, // шампунь / шампуни
    { match: /гель для душа/, type: 'Гель для душа', category: 'Красота и здоровье' },
    { match: /крем для лица/, type: 'Крем', category: 'Красота и здоровье' },
    // «гель» сам по себе — слабое правило: только делает «шампунь-гель» спорным.
    { match: /(?:^|[^а-я])гел[ьяиюе]/, type: 'Гель для душа', category: 'Красота и здоровье', weak: true },
    // Краска для волос: нужны оба слова («краск…» и «волос…») в любом порядке.
    { match: /краск.*волос|волос.*краск/, type: 'Краска для волос', category: 'Красота и здоровье' },
    // Кухня и электроника
    { match: /кофеварк/, type: 'Кофеварка', category: 'Бытовая техника' },
    { match: /наушник/, type: 'Наушники', category: 'Электроника' },
];
const MAX_VARIANTS = 3;
function normalizeName(name) {
    return String(name ?? '').toLowerCase().replace(/ё/g, 'е');
}
function categoriesFor(rule, name) {
    if (typeof rule.category === 'string')
        return [rule.category];
    const female = /женск/.test(name);
    const male = /мужск/.test(name);
    if (female && !male)
        return [rule.category.female];
    if (male && !female)
        return [rule.category.male];
    // Пола нет (или указаны оба) — честно даём оба варианта, выбирать пользователю.
    return [rule.category.female, rule.category.male];
}
/** Подсказка по названию. Не обращается ни к базе, ни к сети. */
function hintCategoryByName(rawName) {
    const name = normalizeName(rawName ?? '');
    if (!name.trim())
        return { status: 'none', variants: [] };
    const strong = [];
    const weak = [];
    for (const rule of exports.HINT_RULES) {
        const m = rule.match.exec(name);
        if (!m)
            continue;
        if (rule.exclude && rule.exclude.test(name))
            continue;
        for (const category of categoriesFor(rule, name)) {
            (rule.weak ? weak : strong).push({ v: { category, type: rule.type }, pos: m.index });
        }
    }
    // Порядок вариантов — как слова идут в названии («платье-рубашка»: платья первыми).
    const key = (v) => `${v.category}|${v.type}`;
    const unique = (list) => {
        const seen = new Set();
        return list
            .map((x, i) => ({ ...x, i }))
            .sort((a, b) => a.pos - b.pos || a.i - b.i)
            .filter((x) => (seen.has(key(x.v)) ? false : (seen.add(key(x.v)), true)))
            .map((x) => x.v);
    };
    const strongVariants = unique(strong);
    if (!strongVariants.length)
        return { status: 'none', variants: [] }; // одно слабое правило подсказку не даёт
    // Слабое правило с другим типом делает название спорным.
    const strongKeys = new Set(strongVariants.map(key));
    const weakExtra = unique(weak).filter((v) => !strongKeys.has(key(v)));
    const all = [...strongVariants, ...weakExtra];
    if (all.length === 1)
        return { status: 'single', variants: all };
    return { status: 'multiple', variants: all.slice(0, MAX_VARIANTS) };
}
/**
 * Стартовый список типов по категориям (расширяемый): попадает в выпадающий
 * список «Тип» в карточке независимо от того, есть ли уже товары с таким типом.
 * Свои типы, вписанные в карточке, добавляются к нему автоматически (таблица
 * ShopCategoryType). Подкатегория тип не заменяет и не дублирует.
 */
exports.STARTER_CATALOG = [
    {
        category: 'Красота и здоровье',
        types: ['Шампунь', 'Гель для душа', 'Крем', 'Краска для волос', 'Тоник', 'Пилинг', 'Сыворотка', 'Маска', 'Тушь', 'Помада', 'Палетка', 'Парфюм'],
    },
];
function starterCatalogPairs() {
    // Типы из приложения (shopCatalogCanon) — первыми: их написание в списке главное.
    const canon = Object.keys(shopCatalogCanon_1.SHOP_CATALOG_CANON).flatMap((category) => (0, shopCatalogCanon_1.canonTypesOf)(category).map((type) => ({ category, type })));
    return [...canon, ...exports.STARTER_CATALOG.flatMap((c) => c.types.map((type) => ({ category: c.category, type })))];
}
/** Все пары category/type, которые знает справочник правил. */
function hintRuleCatalogPairs() {
    const pairs = [];
    for (const rule of exports.HINT_RULES) {
        const cats = typeof rule.category === 'string' ? [rule.category] : [rule.category.female, rule.category.male];
        for (const category of cats)
            pairs.push({ category, type: rule.type });
    }
    return pairs;
}
/** Собирает каталог «категория → её типы» из любых пар; без дублей, по алфавиту. */
function buildCatalog(pairs) {
    // Типы внутри категории склеиваются без учёта регистра и лишних пробелов:
    // «краска для волос» и «Краска для волос» — один тип. Остаётся написание,
    // встреченное первым (порядок pairs: стартовый список и правила идут раньше своих).
    const map = new Map();
    for (const p of pairs) {
        const category = (p.category ?? '').trim();
        const type = (p.type ?? '').replace(/\s+/g, ' ').trim();
        if (!category || !type)
            continue;
        if (!map.has(category))
            map.set(category, new Map());
        const key = type.toLowerCase();
        if (!map.get(category).has(key))
            map.get(category).set(key, type);
    }
    return Array.from(map.entries())
        .map(([category, types]) => ({ category, types: Array.from(types.values()).sort((a, b) => a.localeCompare(b, 'ru')) }))
        .sort((a, b) => a.category.localeCompare(b.category, 'ru'));
}
//# sourceMappingURL=categoryHints.js.map