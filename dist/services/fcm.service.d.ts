export interface ServiceAccount {
    project_id: string;
    client_email: string;
    private_key: string;
}
export declare class FcmConfigError extends Error {
}
/** Разбор FIREBASE_KEY. Бросает FcmConfigError с понятным текстом (без значения ключа). */
export declare function parseFirebaseKey(raw: string | undefined): ServiceAccount;
export declare function signJwt(sa: ServiceAccount, nowSec?: number): string;
/** Сообщение FCM v1. Без картинки полей image нет вовсе. */
export declare function buildFcmMessage(token: string, title: string, body: string, imageUrl?: string | null, data?: Record<string, string>, fullText?: boolean): Record<string, any>;
export interface FcmResult {
    sent: number;
    failed: number;
    notRegistered: number;
    error?: string;
}
export declare function sendFcmBroadcast(tokens: string[], title: string, body: string, imageUrl?: string | null, rawKey?: string | undefined, extraData?: Record<string, string>, fullText?: boolean): Promise<FcmResult>;
/** Только для тестов. */
export declare function _resetFcmCache(): void;
