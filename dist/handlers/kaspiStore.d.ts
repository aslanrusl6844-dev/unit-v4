import { z } from 'zod';
/**
 * Логика вынесена из Express-роута в обычные функции, чтобы её могли
 * использовать ДВА разных входа:
 *  - src/routes/settings.routes.ts — обычный Express-роут (через catch-all
 *    api/[...slug].ts, для локальной разработки и как основной путь);
 *  - api/settings/kaspi-store.ts — ОТДЕЛЬНЫЙ файл-маршрут на Vercel,
 *    страховка на случай проблем с маршрутизацией catch-all для этого
 *    конкретного пути (тот же приём, что уже решил проблему с /api/cron/*).
 */
export declare const kaspiStoreSchema: z.ZodObject<{
    name: z.ZodString;
    bin: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    contactPhone: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    contactEmail: z.ZodNullable<z.ZodOptional<z.ZodString>>;
    apiToken: z.ZodString;
    merchantUid: z.ZodNullable<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    apiToken: string;
    bin?: string | null | undefined;
    contactPhone?: string | null | undefined;
    contactEmail?: string | null | undefined;
    merchantUid?: string | null | undefined;
}, {
    name: string;
    apiToken: string;
    bin?: string | null | undefined;
    contactPhone?: string | null | undefined;
    contactEmail?: string | null | undefined;
    merchantUid?: string | null | undefined;
}>;
export declare function getKaspiStore(): Promise<{
    apiToken: undefined;
    apiTokenMasked: string;
    name: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    bin: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    merchantUid: string | null;
} | null>;
export declare function saveKaspiStore(body: unknown): Promise<{
    status: 400;
    body: {
        error: z.typeToFlattenedError<{
            name: string;
            apiToken: string;
            bin?: string | null | undefined;
            contactPhone?: string | null | undefined;
            contactEmail?: string | null | undefined;
            merchantUid?: string | null | undefined;
        }, string>;
        details?: undefined;
    };
} | {
    status: 201;
    body: {
        apiToken: undefined;
        apiTokenMasked: string;
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        bin: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
        merchantUid: string | null;
        error?: undefined;
        details?: undefined;
    };
} | {
    status: 500;
    body: {
        error: string;
        details: string;
    };
}>;
export declare function deleteKaspiStore(id: string): Promise<{
    status: 204;
    body: null;
} | {
    status: 404;
    body: {
        error: string;
    };
}>;
