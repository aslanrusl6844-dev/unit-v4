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
export declare const WB_WAREHOUSE = "\u0410\u043B\u043C\u0430\u0442\u044B \u0410\u0442\u0430\u043A\u0435\u043D\u0442";
export declare const WB_COEFFICIENT_PCT = 145;
export declare const STORAGE_PER_DAY_FIRST_LITER = 0.12;
export declare const STORAGE_PER_DAY_EXTRA_LITER = 0.12;
export interface WbReturnTariff {
    base: number;
    perExtraLiter: number;
}
export declare const WB_RETURN_TARIFFS: {
    toPickupPoint: WbReturnTariff;
    byCourier: WbReturnTariff;
    unclaimed: WbReturnTariff;
    freight: WbReturnTariff;
    unidentified: WbReturnTariff;
};
/**
 * Логистика доставки до покупателя, ₸/руб — с учётом коэффициента склада.
 * volumeLiters — объём товара в литрах (если не указан у товара — берём 1,
 * см. комментарий у поля wbVolumeLiters в schema.prisma).
 */
export declare function calculateWbLogisticsCost(volumeLiters: number | null | undefined): number;
/**
 * Стоимость возврата — СПРАВОЧНОЕ значение для отдельной колонки, не
 * входит в расчёт прибыли по проданной единице (возврат — не гарантированное
 * событие для каждой продажи). По умолчанию берём тариф "на ПВЗ" — самый
 * частый способ возврата у покупателей.
 */
export declare function calculateWbReturnCost(volumeLiters: number | null | undefined, method?: keyof typeof WB_RETURN_TARIFFS): number;
