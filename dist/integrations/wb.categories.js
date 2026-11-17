"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWbCommissionRate = getWbCommissionRate;
exports.isWbSubjectKnown = isWbSubjectKnown;
exports.getWbCommissionCategory = getWbCommissionCategory;
const wbCommissionRates_json_1 = __importDefault(require("../data/wbCommissionRates.json"));
const wbCommissionRates = wbCommissionRates_json_1.default;
/**
 * Точная ставка комиссии по предмету и схеме. Возвращает null, если
 * предмет не найден в справочнике ИЛИ для найденного предмета не заполнена
 * ставка по этой схеме — по требованию, мы НЕ подставляем выдуманное
 * число, а честно сигналим "нет данных" (интерфейс покажет "—").
 */
function getWbCommissionRate(subject, scheme) {
    if (!subject)
        return null;
    const entry = wbCommissionRates[subject];
    if (!entry)
        return null;
    const rate = scheme === 'FBS' ? entry.fbsPct : entry.fbwPct;
    return rate ?? null;
}
/** Есть ли такой предмет в справочнике вообще (для явного "предмет не найден"). */
function isWbSubjectKnown(subject) {
    if (!subject)
        return false;
    return subject in wbCommissionRates;
}
function getWbCommissionCategory(subject) {
    if (!subject)
        return null;
    return wbCommissionRates[subject]?.category ?? null;
}
//# sourceMappingURL=wb.categories.js.map