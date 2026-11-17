import { z } from 'zod';
/** Логика подключения Ozon — по образцу src/handlers/kaspiStore.ts. */
export declare const ozonStoreSchema: z.ZodObject<{
    clientId: z.ZodString;
    apiKey: z.ZodString;
}, "strip", z.ZodTypeAny, {
    clientId: string;
    apiKey: string;
}, {
    clientId: string;
    apiKey: string;
}>;
export declare function getOzonStore(): Promise<{
    apiKey: undefined;
    apiKeyMasked: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    clientId: string;
} | null>;
export declare function saveOzonStore(body: unknown): Promise<{
    status: 400;
    body: {
        error: z.typeToFlattenedError<{
            clientId: string;
            apiKey: string;
        }, string>;
        details?: undefined;
    };
} | {
    status: 201;
    body: {
        apiKey: undefined;
        apiKeyMasked: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        clientId: string;
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
