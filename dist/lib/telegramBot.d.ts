/** Секрет вебхука выводится из токена бота — отдельная переменная окружения не нужна. */
export declare function webhookSecret(): string;
export declare function allowedChatIds(): string[];
export declare function isAllowedChat(chatId: string | number): boolean;
export type InlineButton = {
    text: string;
    callback_data: string;
};
export declare function sendMessage(chatId: string, text: string, buttons?: InlineButton[][]): Promise<void>;
/** Как sendMessage, но возвращает message_id — чтобы потом узнать, на какое сообщение ответили реплаем. */
export declare function sendMessageWithId(chatId: string, text: string, buttons?: InlineButton[][]): Promise<number>;
/** Присылает 1–10 картинок по URL (альбомом). */
export declare function sendPhotos(chatId: string, urls: string[]): Promise<void>;
export declare function answerCallback(id: string, text?: string): Promise<void>;
/** Скачивает файл из Telegram по file_id. */
export declare function downloadFile(fileId: string): Promise<{
    buffer: Buffer;
    contentType: string;
}>;
export declare function setWebhook(url: string): Promise<void>;
export declare const escapeHtml: (v: string) => string;
