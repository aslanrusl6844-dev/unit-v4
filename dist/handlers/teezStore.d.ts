import { z } from 'zod';
/** Логика подключения Teez — по образцу src/handlers/wbStore.ts / ozonStore.ts. */
export declare const teezStoreSchema: z.ZodObject<{
    clientId: z.ZodString;
    clientSecret: z.ZodString;
}, "strip", z.ZodTypeAny, {
    clientId: string;
    clientSecret: string;
}, {
    clientId: string;
    clientSecret: string;
}>;
export declare function getTeezStore(): Promise<{
    clientSecret: undefined;
    clientSecretMasked: string;
    clientId: string;
} | null>;
export declare function saveTeezStore(body: unknown): Promise<{
    status: 400;
    body: {
        error: z.typeToFlattenedError<{
            clientId: string;
            clientSecret: string;
        }, string>;
        details?: undefined;
    };
} | {
    status: 201;
    body: {
        connection: {
            ok: boolean;
            error?: string;
        };
        clientSecret: undefined;
        clientSecretMasked: string;
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
