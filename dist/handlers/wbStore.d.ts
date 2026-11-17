import { z } from 'zod';
/** Логика подключения Wildberries — по образцу src/handlers/ozonStore.ts. */
export declare const wbStoreSchema: z.ZodObject<{
    apiToken: z.ZodString;
}, "strip", z.ZodTypeAny, {
    apiToken: string;
}, {
    apiToken: string;
}>;
export declare function getWbStore(): Promise<{
    apiToken: undefined;
    apiTokenMasked: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
} | null>;
export declare function saveWbStore(body: unknown): Promise<{
    status: 400;
    body: {
        error: z.typeToFlattenedError<{
            apiToken: string;
        }, string>;
        details?: undefined;
    };
} | {
    status: 201;
    body: {
        apiToken: undefined;
        apiTokenMasked: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
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
