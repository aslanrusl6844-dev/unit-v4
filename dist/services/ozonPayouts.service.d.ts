/** Не чаще раза в 20 минут без force (отметка JobMark), чтобы не упираться в лимиты Ozon. */
export declare function refreshOzonAccruals(opts?: {
    force?: boolean;
}): Promise<{
    checked: number;
    settled: number;
    skipped: string;
} | {
    checked: number;
    settled: number;
    skipped?: undefined;
}>;
/** Периоды выплат Ozon: с 1 по 15 и с 16 по последний день месяца (даты по Алматы, UTC+5). */
export declare function payoutPeriodOf(d: Date): {
    key: string;
    from: string;
    to: string;
};
export declare function getOzonPayoutReport(params: {
    from: Date;
    to: Date;
    wholesalerId?: string | null;
    marketplace?: 'OZON' | 'TEEZ';
}): Promise<{
    taxRatePct: number;
    from: string;
    to: string;
    settled: {
        quantity: number;
        revenue: number;
        commission: number;
        logistics: number;
        otherFees: number;
        payout: number;
        tax: number;
        wholesaler: number;
        net: number;
        orders: number;
    };
    pending: {
        quantity: number;
        revenue: number;
        commission: number;
        logistics: number;
        otherFees: number;
        payout: number;
        tax: number;
        wholesaler: number;
        net: number;
        orders: number;
    };
    periods: {
        quantity: number;
        revenue: number;
        commission: number;
        logistics: number;
        otherFees: number;
        payout: number;
        tax: number;
        wholesaler: number;
        net: number;
        from: string;
        to: string;
        orders: number;
    }[];
    store: {
        cashFlows: {
            begin: string | null;
            end: string | null;
            accrued: number;
            orders: number;
            paid: number;
            endBalance: number | null;
        }[];
        cashFlowsError: string | null;
        balance: {
            opening: number | null;
            closing: number | null;
            accrued: number | null;
            paid: number;
            currency: string | null;
        } | null;
    };
}>;
