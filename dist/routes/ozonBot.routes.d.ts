/**
 * Озон-менеджер — ОТДЕЛЬНЫЙ Telegram-бот (свой токен OZON_BOT_TOKEN), только для владельца
 * (OZON_BOT_OWNER_ID — его chat id). Вебхук: /api/ozon-bot/webhook, защита — секрет из токена.
 */
export declare const ozonBotRouter: import("express-serve-static-core").Router;
export declare const ozonBotSecret: () => string;
type TgFetch = typeof fetch;
export declare function setOzonBotTelegramFetch(f: TgFetch | null): void;
/** Отправить текст (HTML), длинный — кусками; если Telegram не принял разметку — тем же текстом без неё. */
export declare function sendOzonBot(chatId: string, text: string): Promise<void>;
export declare function handleOzonBotUpdate(update: any): Promise<void>;
/** Отчёт владельцу (утро/вечер) — зовёт крон. */
export declare function sendOzonBotReport(kind: 'morning' | 'evening'): Promise<{
    sent: boolean;
    reason?: string;
}>;
export {};
