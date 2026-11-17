export type WholesalerWaybillMarketplace = 'KASPI' | 'OZON' | 'WB' | 'APP';
export interface WholesalerWaybillItem {
    sku: string;
    article: string | null;
    name: string;
    quantity: number;
}
export interface WholesalerWaybillInput {
    wholesalerName: string;
    marketplace: WholesalerWaybillMarketplace;
    orderNumber: string;
    orderDate: Date;
    city: string | null;
    items: WholesalerWaybillItem[];
}
/** Генерирует накладную оптовика по заказу. Цена и финансовые суммы не печатаются. */
export declare function generateWholesalerWaybillPdf(input: WholesalerWaybillInput): Promise<Buffer>;
