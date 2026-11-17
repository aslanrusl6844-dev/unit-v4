export interface ImportError {
    file: string;
    message: string;
}
export interface CatalogImageItem {
    source: string;
    category: string;
    type: string;
    ext: string;
    contentType: string;
    buffer: Buffer;
}
export interface ParsedImageZip {
    items: CatalogImageItem[];
    errors: ImportError[];
    skippedJunk: number;
}
export interface CatalogTypePair {
    category: string;
    type: string;
}
export declare function normalizeKey(value: string): string;
export declare function cleanName(value: string): string;
export declare function capitalizeFirst(value: string): string;
/**
 * ZIP layout: "Название раздела/Название типа.jpg".
 * Nested folders are tolerated; the first folder is the category and the
 * file basename (without extension) is the type. Non-image/system files are
 * ignored rather than causing the whole archive to fail.
 */
export declare function parseImageZip(input: Buffer): Promise<ParsedImageZip>;
/** Parses one "Категория | Тип" pair per line without guessing category names. */
export declare function parseBulkText(text: string): {
    pairs: CatalogTypePair[];
    errors: ImportError[];
};
