import { z } from 'zod';
/**
 * Ставка налога ИП — по умолчанию 4% (упрощёнка: налог считается от
 * ВЫРУЧКИ, не от прибыли). Одна запись на сервер, настраивается в разделе
 * «Настройки».
 */
export declare const taxSettingsSchema: z.ZodObject<{
    ratePct: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    ratePct: number;
}, {
    ratePct: number;
}>;
export declare function getTaxSettings(): Promise<{
    ratePct: number;
}>;
/** Только число ставки — для использования внутри analytics.service.ts,
 *  без лишних полей. */
export declare function getTaxRatePct(): Promise<number>;
export declare function saveTaxSettings(body: unknown): Promise<{
    status: 400;
    body: {
        error: z.typeToFlattenedError<{
            ratePct: number;
        }, string>;
        details?: undefined;
    };
} | {
    status: 201;
    body: {
        ratePct: number;
        id: string;
        updatedAt: Date;
    };
} | {
    status: 500;
    body: {
        error: string;
        details: string;
    };
}>;
