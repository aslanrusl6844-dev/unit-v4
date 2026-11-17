import { z } from 'zod';
/** Подключение Yandex Cloud (Wordstat) — по образцу src/handlers/teezStore.ts. */
export declare const yandexCloudSchema: z.ZodEffects<z.ZodObject<{
    folderId: z.ZodString;
    apiKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    apiKey: string;
    folderId: string;
}, {
    apiKey: string;
    folderId: string;
}>, {
    apiKey: string;
    folderId: string;
}, {
    apiKey: string;
    folderId: string;
}>;
export declare function getYandexCloudStore(): Promise<{
    apiKey: undefined;
    apiKeyMasked: string;
    folderId: string;
} | null>;
export declare function saveYandexCloudStore(body: unknown): Promise<{
    status: 400;
    body: {
        error: z.typeToFlattenedError<{
            apiKey: string;
            folderId: string;
        }, string>;
        details?: undefined;
    };
} | {
    status: 201;
    body: {
        apiKey: undefined;
        apiKeyMasked: string;
        folderId: string;
    };
} | {
    status: 500;
    body: {
        error: string;
        details: string;
    };
}>;
