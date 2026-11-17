export declare class WaybillAddressError extends Error {
}
export interface WaybillOrderItem {
    sku: string;
    name: string;
    quantity: number;
}
export interface WaybillOrderInput {
    number: string;
    customerName: string;
    phone: string;
    city: string;
    street: string;
    house: string;
    apartment: string | null;
    entrance: string | null;
    floor: string | null;
    intercom: string | null;
    items: WaybillOrderItem[];
}
/**
 * Наклейка-накладная My Market, 75×120 мм — макет повторяет образец,
 * присланный пользователем (MyMarket_nakladnaya_kaspi.pdf): чёрная шапка,
 * крупный номер заказа, штрихкод, блоки ОТКУДА/ПОЛУЧАТЕЛЬ/АДРЕС/ТОВАР с
 * тонкими разделителями, QR — справа от адреса.
 *
 * Запрещённые поля НЕ печатаются никогда, вне зависимости от того, что
 * передано на вход: цена, сумма, налог, код получения, блок "Выдача" —
 * это осознанное ограничение самой функции, не настройка, которую можно
 * случайно включить.
 *
 * Вся вёрстка — фиксированными координатами (не автопоток pdfkit), чтобы
 * гарантированно уместиться в ровно одну страницу 75×120мм — сумма высот
 * всех блоков посчитана и уложена в 340.2pt с запасом, проверено рендером.
 */
export declare function generateWaybillPdf(order: WaybillOrderInput): Promise<Buffer>;
