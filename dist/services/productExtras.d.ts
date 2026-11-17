import { z } from 'zod';
/**
 * Варианты количества (1/2/3/4 шт или кг, у каждого своя цена): JSON-строка в
 * Product.quantityVariants. «Детали» (фото/видео): массив URL в Product.details (Json).
 */
export declare const MAX_QUANTITY_VARIANTS = 20;
export declare const MAX_DETAILS = 10;
export declare const MAX_VIDEOS = 3;
export declare const MAX_SHOWCASE_VIDEOS = 20;
export declare const QUANTITY_UNITS: readonly ["шт", "кг"];
export type QuantityVariant = {
    quantity: number;
    unit: (typeof QUANTITY_UNITS)[number];
    price: number;
};
export declare const quantityVariantSchema: z.ZodObject<{
    quantity: z.ZodNumber;
    unit: z.ZodDefault<z.ZodOptional<z.ZodEnum<["шт", "кг"]>>>;
    price: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    quantity: number;
    unit: "шт" | "кг";
    price: number;
}, {
    quantity: number;
    price: number;
    unit?: "шт" | "кг" | undefined;
}>;
export declare const quantityVariantsSchema: z.ZodEffects<z.ZodArray<z.ZodObject<{
    quantity: z.ZodNumber;
    unit: z.ZodDefault<z.ZodOptional<z.ZodEnum<["шт", "кг"]>>>;
    price: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    quantity: number;
    unit: "шт" | "кг";
    price: number;
}, {
    quantity: number;
    price: number;
    unit?: "шт" | "кг" | undefined;
}>, "many">, {
    quantity: number;
    unit: "шт" | "кг";
    price: number;
}[], {
    quantity: number;
    price: number;
    unit?: "шт" | "кг" | undefined;
}[]>;
export declare const detailsSchema: z.ZodEffects<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">, string[], string[]>;
/** Для записи в БД: пустой массив → null. */
export declare function serializeJsonArray(arr: unknown[] | null | undefined): string | null;
/** Для чтения из БД: битые/пустые данные → [], без падения; мусорные элементы отбрасываются. */
export declare function parseQuantityVariants(raw: unknown): QuantityVariant[];
/** Details из БД (Json) → массив URL. Битое/не массив → []; нестроки и не-http отбрасываются. */
export declare function parseDetails(raw: unknown): string[];
/** Видео товара — до 3. */
export declare const videosSchema: z.ZodEffects<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">, string[], string[]>;
/** Видео витрины — до 20. */
export declare const showcaseVideosSchema: z.ZodEffects<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">, string[], string[]>;
/** videos из БД → массив URL. Нет поля/битые данные → []; не-http и нестроки отбрасываются. */
export declare function parseVideos(raw: unknown, max?: number): string[];
