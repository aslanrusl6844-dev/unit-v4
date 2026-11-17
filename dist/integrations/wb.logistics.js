"use strict";
/**
 * Тарифы логистики Wildberries — склад Алматы Атакент, тип поставки
 * "Коробка", объём >1 литра, коэффициент склада 145% (снимок от 09.09.2026,
 * предоставлен пользователем из личного кабинета WB → Тарифы складов).
 *
 * ВАЖНО, честно: это НЕ живые данные из API (у WB есть официальный метод
 * /api/v1/tariffs/box для актуальных тарифов, но в этой версии используется
 * зафиксированный снимок конкретно этого склада и даты — тарифы и
 * коэффициент склада у WB меняются день ото дня и по сезону, поэтому со
 * временем эти цифры могут разойтись с реальными). Если нужно — можно
 * позже заменить на запрос к /api/v1/tariffs/box, но сейчас считаем по
 * цифрам, которые пользователь явно подтвердил из своего кабинета.
 *
 * Логистика WB считается ПО ЛИТРАМ ОБЪЁМА (не процентом от цены, в отличие
 * от Ozon/Kaspi) — первый литр по одной ставке, каждый следующий литр — по
 * другой, надбавка. Коэффициент склада (145%) умножает тариф доставки.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WB_RETURN_TARIFFS = exports.STORAGE_PER_DAY_EXTRA_LITER = exports.STORAGE_PER_DAY_FIRST_LITER = exports.WB_COEFFICIENT_PCT = exports.WB_WAREHOUSE = void 0;
exports.calculateWbLogisticsCost = calculateWbLogisticsCost;
exports.calculateWbReturnCost = calculateWbReturnCost;
exports.WB_WAREHOUSE = 'Алматы Атакент';
exports.WB_COEFFICIENT_PCT = 145; // коэффициент склада, %
// --- Поставка (доставка до покупателя) ---
const DELIVERY_FIRST_LITER = 66.7;
const DELIVERY_EXTRA_LITER = 20.3;
exports.STORAGE_PER_DAY_FIRST_LITER = 0.12;
exports.STORAGE_PER_DAY_EXTRA_LITER = 0.12;
exports.WB_RETURN_TARIFFS = {
    toPickupPoint: { base: 152.1, perExtraLiter: 18.9 }, // на ПВЗ
    byCourier: { base: 252.1, perExtraLiter: 18.9 }, // курьером
    unclaimed: { base: 250, perExtraLiter: 0 }, // невостребованный возврат (фикс.)
    freight: { base: 1062.1, perExtraLiter: 18.9 }, // грузовая доставка
    unidentified: { base: 170, perExtraLiter: 0 }, // неопознанный товар (фикс.)
};
/**
 * Логистика доставки до покупателя, ₸/руб — с учётом коэффициента склада.
 * volumeLiters — объём товара в литрах (если не указан у товара — берём 1,
 * см. комментарий у поля wbVolumeLiters в schema.prisma).
 */
function calculateWbLogisticsCost(volumeLiters) {
    const volume = volumeLiters && volumeLiters > 0 ? volumeLiters : 1;
    const extraLiters = Math.max(0, volume - 1);
    const baseCost = DELIVERY_FIRST_LITER + extraLiters * DELIVERY_EXTRA_LITER;
    return round2(baseCost * (exports.WB_COEFFICIENT_PCT / 100));
}
/**
 * Стоимость возврата — СПРАВОЧНОЕ значение для отдельной колонки, не
 * входит в расчёт прибыли по проданной единице (возврат — не гарантированное
 * событие для каждой продажи). По умолчанию берём тариф "на ПВЗ" — самый
 * частый способ возврата у покупателей.
 */
function calculateWbReturnCost(volumeLiters, method = 'toPickupPoint') {
    const volume = volumeLiters && volumeLiters > 0 ? volumeLiters : 1;
    const extraLiters = Math.max(0, volume - 1);
    const tariff = exports.WB_RETURN_TARIFFS[method];
    return round2(tariff.base + extraLiters * tariff.perExtraLiter);
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
//# sourceMappingURL=wb.logistics.js.map