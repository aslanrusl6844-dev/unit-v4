/** Условие «товара ещё нет в My Market» для запроса к базе. */
export declare const NOT_IN_MY_MARKET: {
    readonly shopPrice: null;
    readonly shopArticle: null;
    readonly shopActive: false;
    readonly shopArchived: false;
    readonly shopStock: 0;
    readonly NOT: {
        readonly sku: {
            readonly startsWith: "mm-";
        };
    };
};
export interface OzonImportResult {
    processed: number;
    added: number;
    addedWithoutCategory: number;
    skippedNoPrice: number;
    unmappedTypes: string[];
    nextCursor: string | null;
    done: boolean;
}
export declare function importOzonToMyMarket(limit?: number, cursor?: string): Promise<OzonImportResult>;
