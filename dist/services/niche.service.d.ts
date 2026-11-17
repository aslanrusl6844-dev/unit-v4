export interface NicheAnalysisResult {
    input: string;
    resolvedUrl: string;
    productName: string | null;
    category: string | null;
    sellerCount: number | null;
    priceMin: number | null;
    priceMax: number | null;
    priceMedian: number | null;
    ratingValue: number | null;
    reviewCount: number | null;
    estimatedMonthlySales: number | null;
    estimatedMonthlyRevenue: number | null;
    commissionRatePct: number | null;
    estimatedMonthlyCommission: number | null;
    estimatedMonthlyLogistics: number | null;
    taxRatePct: number;
    estimatedMonthlyTax: number | null;
    estimatedMonthlyNetProfit: number | null;
    verdict: 'strong' | 'medium' | 'weak' | 'unknown';
    verdictReason: string;
    isOwnProduct: boolean;
    ownProductExactData: null | {
        referencePrice: number | null;
        estCommission: number | null;
        estLogistics: number | null;
        estTax: number | null;
        estPayout: number | null;
        estMarginAfterTaxPct: number | null;
    };
    dataQualityWarning: string;
}
export declare function analyzeNiche(rawInput: string): Promise<NicheAnalysisResult>;
