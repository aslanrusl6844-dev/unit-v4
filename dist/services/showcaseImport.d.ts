export declare const MAX_IMPORT_BATCH = 25;
export declare const MAX_ROW_PHOTOS = 10;
export declare const MAX_ROW_VIDEOS = 3;
export interface ImportRow {
    row: number | null;
    sku: string;
    name: string;
    category: string;
    subcategory: string | null;
    type: string;
    shopPrice: number;
    shopOldPrice: number | null;
    shopStock: number;
    shopDelivery: 'rocket' | 'truck' | null;
    shopActive: boolean;
    images: string[] | null;
    description: string | null;
    composition: string | null;
    videoUrl: string | null;
}
export interface ImportRowResult {
    ok: true;
    row: ImportRow;
    warnings: string[];
}
/** images: JSON-строка / массив / строка со ссылками через | или перенос → http(s)-ссылки без повторов. */
export declare function parsePhotos(raw: unknown): {
    urls: string[] | null;
    skipped: number;
};
/** Одна строка → нормальный вид либо текст ошибки (строка отклоняется, остальные грузятся). */
export declare function normalizeImportRow(input: Record<string, unknown>): {
    ok: false;
    error: string;
    sku: string;
} | ImportRowResult;
/** «В продаже» можно включить только для категории из списка разделов витрины. */
export declare function resolveActive(wantActive: boolean, category: string): {
    active: boolean;
    downgraded: boolean;
};
/** Новое видео ставится первым, остальные остаются (без повторов, до MAX_ROW_VIDEOS). */
export declare function mergeVideos(current: unknown, url: string): string[];
