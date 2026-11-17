export type CollageItem = {
    qty: number;
    name: string;
    image: Buffer | null;
    index: number;
};
/** Один коллаж (до 9 товаров) → JPEG. */
export declare function buildCollage(items: CollageItem[]): Promise<Buffer>;
