export declare const isExpoToken: (t: unknown) => t is string;
export interface BroadcastInput {
    title: string;
    body: string;
    imageUrl?: string | null;
    tokens: string[];
    data?: Record<string, string>;
    fullText?: boolean;
}
export interface BroadcastResult {
    total: number;
    expoTokens: number;
    fcmTokens: number;
    sent: number;
    failed: number;
    notRegistered: number;
    withImage: boolean;
    fcmError?: string;
}
/** Одно сообщение Expo: без картинки поля richContent/image не добавляются вовсе. */
export declare function buildExpoMessage(token: string, title: string, body: string, imageUrl?: string | null, data?: Record<string, string>): Record<string, unknown>;
export declare function sendBroadcast(input: BroadcastInput): Promise<BroadcastResult>;
export declare const PUSH_IMAGE_MAX_BYTES = 1000000;
/**
 * Проверка картинки пуша ДО отправки: доступна ли по ссылке, это ли картинка, не тяжелее ли 1 МБ.
 * Ничего не блокирует — возвращает понятное предупреждение, почему картинка может не показаться
 * (система телефона сама скачивает её по ссылке; при ошибке пуш приходит без картинки).
 */
export declare function checkPushImage(url: string): Promise<string | null>;
