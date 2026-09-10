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

export const WB_WAREHOUSE = 'Алматы Атакент';
export const WB_COEFFICIENT_PCT = 145; // коэффициент склада, %

// --- Поставка (доставка до покупателя) ---
const DELIVERY_FIRST_LITER = 66.7;
const DELIVERY_EXTRA_LITER = 20.3;
export const STORAGE_PER_DAY_FIRST_LITER = 0.12;
export const STORAGE_PER_DAY_EXTRA_LITER = 0.12;

// --- Возврат с Атакента (СПРАВОЧНО, отдельной колонкой — НЕ вычитается
// из прибыли каждой продажи, т.к. возврат случается не по каждому заказу) ---
export interface WbReturnTariff {
  base: number;
  perExtraLiter: number;
}
export const WB_RETURN_TARIFFS = {
  toPickupPoint: { base: 152.1, perExtraLiter: 18.9 } as WbReturnTariff, // на ПВЗ
  byCourier: { base: 252.1, perExtraLiter: 18.9 } as WbReturnTariff, // курьером
  unclaimed: { base: 250, perExtraLiter: 0 } as WbReturnTariff, // невостребованный возврат (фикс.)
  freight: { base: 1062.1, perExtraLiter: 18.9 } as WbReturnTariff, // грузовая доставка
  unidentified: { base: 170, perExtraLiter: 0 } as WbReturnTariff, // неопознанный товар (фикс.)
};

/**
 * Логистика доставки до покупателя, ₸/руб — с учётом коэффициента склада.
 * volumeLiters — объём товара в литрах (если не указан у товара — берём 1,
 * см. комментарий у поля wbVolumeLiters в schema.prisma).
 */
export function calculateWbLogisticsCost(volumeLiters: number | null | undefined): number {
  const volume = volumeLiters && volumeLiters > 0 ? volumeLiters : 1;
  const extraLiters = Math.max(0, volume - 1);
  const baseCost = DELIVERY_FIRST_LITER + extraLiters * DELIVERY_EXTRA_LITER;
  return round2(baseCost * (WB_COEFFICIENT_PCT / 100));
}

/**
 * Стоимость возврата — СПРАВОЧНОЕ значение для отдельной колонки, не
 * входит в расчёт прибыли по проданной единице (возврат — не гарантированное
 * событие для каждой продажи). По умолчанию берём тариф "на ПВЗ" — самый
 * частый способ возврата у покупателей.
 */
export function calculateWbReturnCost(volumeLiters: number | null | undefined, method: keyof typeof WB_RETURN_TARIFFS = 'toPickupPoint'): number {
  const volume = volumeLiters && volumeLiters > 0 ? volumeLiters : 1;
  const extraLiters = Math.max(0, volume - 1);
  const tariff = WB_RETURN_TARIFFS[method];
  return round2(tariff.base + extraLiters * tariff.perExtraLiter);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
