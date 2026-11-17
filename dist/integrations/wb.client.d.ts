import { NormalizedOrder } from '../types';
/** Строка детализации отчёта реализации (новый метод WB, finance-api): деньги приходят строками. */
interface WbRealizationRow {
    srid?: string;
    rrdId?: number;
    ppvzSalesCommission?: string | number;
    deliveryService?: string | number;
    rebillLogisticCost?: string | number;
    acquiringFee?: string | number;
}
/** Суммы комиссии/логистики/эквайринга по srid из строк детализации. */
export declare function financeBySrid(rows: WbRealizationRow[]): Map<string, WbFinanceTotals>;
interface WbFinanceTotals {
    commission: number;
    logistics: number;
    acquiring: number;
}
export declare class WbClient {
    isConfigured(): Promise<boolean>;
    private getHttp;
    private getFinanceHttp;
    private getContentHttp;
    private getPricesHttp;
    /**
     * Текущие цены товаров — GET /api/v2/list/goods/filter (без указания
     * артикула — отдаёт по ВСЕМ товарам сразу, так рекомендует официальная
     * документация). Подтверждённый формат ответа:
     *   { data: { listGoods: [ { nmID, vendorCode, sizes: [{ price, discountedPrice }], ... } ] } }
     * Берём discountedPrice — это реальная цена, которую платит покупатель
     * (с учётом скидки продавца), а не список price без скидки.
     */
    fetchPrices(): Promise<Map<number, number>>;
    /**
     * Полный каталог карточек товаров — POST /content/v2/get/cards/list,
     * с постраничной курсорной пагинацией (limit + cursor.updatedAt/nmID из
     * предыдущего ответа). У каждой карточки: nmID (номер WB), vendorCode
     * (= supplierArticle, наш wbArticle) и title (название).
     */
    fetchCatalog(): Promise<Array<{
        vendorCode: string;
        name: string;
        nmId: number;
        subject?: string;
        images: string[];
    }>>;
    fetchOrders(params: {
        dateFrom: Date;
        dateTo: Date;
    }): Promise<NormalizedOrder[]>;
    /** Постранично тянет /api/v1/supplier/orders, используя lastChangeDate для пагинации. */
    private fetchOrderRows;
    /**
     * Комиссия/логистика/эквайринг по каждому srid из детализации отчётов реализации (новый метод WB).
     * Лимит WB — 1 запрос в минуту, поэтому берём одну страницу (до 100 000 строк — с запасом для 2–30 дней).
     */
    private fetchFinanceBySrid;
    private toNormalizedOrder;
}
export declare const wbClient: WbClient;
export {};
