"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_CITY_IMAGES = exports.CITY_IMAGE_CITIES = void 0;
exports.normalizeCityKey = normalizeCityKey;
exports.resolveCity = resolveCity;
/** Города, для которых в админке загружаются картинки («Картинки городов»). Порядок — как показывается в админке. */
exports.CITY_IMAGE_CITIES = [
    'Алматы', 'Астана', 'Шымкент', 'Караганда', 'Актобе', 'Тараз', 'Павлодар', 'Усть-Каменогорск', 'Семей', 'Атырау',
    'Костанай', 'Кызылорда', 'Уральск', 'Петропавловск', 'Актау', 'Туркестан', 'Кокшетау', 'Талдыкорган', 'Экибастуз', 'Жезказган',
];
/** Старые/альтернативные названия → город из списка. */
const ALIASES = new Map(Object.entries({
    'алма-ата': 'Алматы', 'алма ата': 'Алматы',
    'нур-султан': 'Астана', 'нурсултан': 'Астана', 'нур султан': 'Астана', 'целиноград': 'Астана', 'акмола': 'Астана',
    'чимкент': 'Шымкент',
}));
/** Сопоставление без учёта регистра, ё/е, дефисов/пробелов и лишних пробелов. */
function normalizeCityKey(raw) {
    return String(raw ?? '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[-–—\s]+/g, ' ')
        .trim();
}
const BY_KEY = new Map(exports.CITY_IMAGE_CITIES.map((c) => [normalizeCityKey(c), c]));
/** Каноническое название города из списка или null, если города нет в списке. */
function resolveCity(raw) {
    const key = normalizeCityKey(raw);
    if (!key)
        return null;
    return BY_KEY.get(key) ?? ALIASES.get(key) ?? null;
}
/** Максимум картинок (слайдов) на один город. */
exports.MAX_CITY_IMAGES = 10;
//# sourceMappingURL=cities.js.map