/**
 * Тарифы "Kaspi Доставка", действуют с 01.01.2026 (без НДС).
 * Источник: guide.kaspi.kz — "Сколько стоит Kaspi Доставка?"
 *
 * Правило начисления (официальное): стоимость доставки списывается с
 * продавца ТОЛЬКО когда заказ получен покупателем (статус "Выдан").
 * При отмене — не списывается. При возврате — списывается полностью,
 * как за состоявшуюся доставку (обратная перевозка бесплатна для продавца).
 */

export type KaspiDeliveryZone = 'city' | 'kazakhstan' | 'express';

interface TariffRow {
  // Верхняя граница суммы заказа (₸) или веса (кг) для этой строки, включительно.
  upTo: number;
  city: number;
  kazakhstan: number;
  express: number;
}

// Тарифы для заказов дешевле 10 000 ₸ — считаются по сумме заказа.
const AMOUNT_TARIFF: TariffRow[] = [
  { upTo: 1000, city: 49, kazakhstan: 49, express: 49 },
  { upTo: 3000, city: 149, kazakhstan: 149, express: 149 },
  { upTo: 5000, city: 199, kazakhstan: 199, express: 199 },
  { upTo: 10000, city: 699, kazakhstan: 799, express: 799 },
];

// Тарифы для заказов от 10 000 ₸ — считаются по весу.
const WEIGHT_TARIFF: TariffRow[] = [
  { upTo: 5, city: 1099, kazakhstan: 1299, express: 1699 },
  { upTo: 15, city: 1349, kazakhstan: 1699, express: 1849 },
  { upTo: 30, city: 2299, kazakhstan: 3599, express: 3149 },
  { upTo: 60, city: 2899, kazakhstan: 5649, express: 3599 },
  { upTo: 100, city: 4149, kazakhstan: 8549, express: 5599 },
  { upTo: Infinity, city: 6449, kazakhstan: 11999, express: 8449 },
];

/**
 * Считает стоимость Kaspi Доставки для одного заказа.
 * @param orderAmount сумма заказа в ₸
 * @param weightKg суммарный вес заказа в кг (если неизвестен — передайте
 *   оценку; в карточке товара стоит завести поле веса для точности)
 * @param zone зона доставки: 'city' (по городу продавца), 'kazakhstan'
 *   (по остальному Казахстану) или 'express'
 */
export function calculateKaspiDeliveryCost(
  orderAmount: number,
  weightKg: number,
  zone: KaspiDeliveryZone = 'kazakhstan',
): number {
  const table = orderAmount < 10000 ? AMOUNT_TARIFF : WEIGHT_TARIFF;
  const metric = orderAmount < 10000 ? orderAmount : weightKg;

  const row = table.find((r) => metric <= r.upTo) ?? table[table.length - 1];
  return row[zone];
}
