import { z } from 'zod';
export declare const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
export declare const detailsSchema: z.ZodObject<{
    name: z.ZodString;
    category: z.ZodEffects<z.ZodString, string, string>;
    subcategory: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    type: z.ZodString;
    description: z.ZodString;
    composition: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    characteristics: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        value: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        value: string;
        name: string;
    }, {
        value: string;
        name: string;
    }>, "many">>;
    usage: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    scenes: z.ZodDefault<z.ZodArray<z.ZodObject<{
        headline: z.ZodString;
        caption: z.ZodString;
        prompt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        prompt: string;
        caption: string;
        headline: string;
    }, {
        prompt: string;
        caption: string;
        headline: string;
    }>, "many">>;
    features: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    notFound: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    questions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    type: string;
    name: string;
    category: string;
    description: string;
    characteristics: {
        value: string;
        name: string;
    }[];
    scenes: {
        prompt: string;
        caption: string;
        headline: string;
    }[];
    features: string[];
    notFound: string[];
    questions: string[];
    subcategory?: string | null | undefined;
    composition?: string | null | undefined;
    usage?: string | null | undefined;
}, {
    type: string;
    name: string;
    category: string;
    description: string;
    subcategory?: string | null | undefined;
    composition?: string | null | undefined;
    characteristics?: {
        value: string;
        name: string;
    }[] | undefined;
    usage?: string | null | undefined;
    scenes?: {
        prompt: string;
        caption: string;
        headline: string;
    }[] | undefined;
    features?: string[] | undefined;
    notFound?: string[] | undefined;
    questions?: string[] | undefined;
}>;
export type ProductDetails = z.infer<typeof detailsSchema>;
/** Достаёт JSON-объект из ответа модели (с ```json``` или без). */
export declare function extractJson(text: string): unknown;
/** «4500 / 6000», «цена 4 500 старая 6 000» → { price, oldPrice }. */
export declare function parsePrices(text: string): {
    price?: number;
    oldPrice?: number;
};
export declare function buildDetailsPrompt(taxonomy: string): string;
export declare function runDetailsAgent(opts: {
    apiKey: string;
    model?: string;
    photos: string[];
    notes?: string | null;
    price?: number | null;
    oldPrice?: number | null;
    taxonomy: string;
    feedback?: string | null;
    previous?: ProductDetails | null;
    fetchImpl?: typeof fetch;
}): Promise<ProductDetails>;
