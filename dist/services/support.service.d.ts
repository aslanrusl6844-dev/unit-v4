export type SupportStatus = 'waiting' | 'active' | 'closed';
export declare const MAX_TEXT = 2000;
/** Клиент не ответил столько после сообщения оператора — чат с оператором закрывается сам. */
export declare const IDLE_MS = 60000;
export declare const IDLE_TEXT = "\u0427\u0430\u0442 \u0441 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D: \u0432\u044B \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B\u0438 \u0432 \u0442\u0435\u0447\u0435\u043D\u0438\u0435 \u043C\u0438\u043D\u0443\u0442\u044B. \u0415\u0441\u043B\u0438 \u0432\u043E\u043F\u0440\u043E\u0441 \u043E\u0441\u0442\u0430\u043B\u0441\u044F \u2014 \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435, \u0411\u0430\u0443\u0440\u0441\u0430\u043A \u043D\u0430 \u0441\u0432\u044F\u0437\u0438 \uD83D\uDE42";
/** Адрес этого же сервера (ставит вебхук бота) — для проверки «клиент молчит минуту» отдельным вызовом. */
export declare function setSupportBaseUrl(url: string): void;
/** Просит ли клиент живого человека. Приложение соединяет только со второй такой просьбы. */
export declare function isOperatorRequest(text: string): boolean;
type IdleFields = {
    status: string;
    lastOperatorAt?: Date | null;
    lastCustomerAt?: Date | null;
};
/** Оператор написал, клиент после этого молчит дольше IDLE_MS. */
export declare function idleExpired(chat: IdleFields, now?: number): boolean;
/** Закрывает чат, если клиент молчит минуту после оператора. true — закрыли сейчас. */
export declare function closeIfIdle(chatId: string, now?: number): Promise<boolean>;
/**
 * Вызов /support-idle: ждёт, пока выйдет минута тишины (не дольше ~45 с за вызов, иначе передаёт
 * ожидание следующему вызову), и закрывает чат, если клиент так и не ответил.
 */
export declare function runIdleCheck(chatId: string): Promise<void>;
export interface StartInput {
    phone?: string | null;
    customerName?: string | null;
    pushToken?: string | null;
    question?: string | null;
    history?: unknown;
}
export declare function startChat(input: StartInput): Promise<{
    number: number;
    status: string;
    pushToken: string | null;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    token: string;
    phone: string | null;
    customerName: string | null;
    operatorName: string | null;
    operatorTgChatId: string | null;
    lastOperatorAt: Date | null;
    lastCustomerAt: Date | null;
    closedAt: Date | null;
    closedBy: string | null;
}>;
export type CustomerResult = {
    ok: true;
    message: any;
} | {
    ok: false;
    code: 404 | 409 | 400;
    error: string;
};
export declare function customerMessage(id: string, token: string, rawText: unknown): Promise<CustomerResult>;
export declare function chatState(id: string, token: string, after?: number): Promise<{
    id: string;
    number: number;
    status: SupportStatus;
    operatorName: string | null;
    messages: {
        id: any;
        sender: any;
        text: any;
        operatorName: any;
        createdAt: any;
    }[];
} | null>;
export declare function closeByCustomer(id: string, token: string): Promise<boolean>;
export type SupportTgUpdate = {
    message?: {
        message_id?: number;
        chat: {
            id: number;
        };
        from?: {
            id: number;
            first_name?: string;
            last_name?: string;
            username?: string;
        };
        text?: string;
        reply_to_message?: {
            message_id: number;
        };
    };
    callback_query?: {
        id: string;
        data?: string;
        from?: {
            id: number;
            first_name?: string;
        };
        message?: {
            chat: {
                id: number;
            };
        };
    };
};
/**
 * Обрабатывает апдейт Telegram, если он относится к чатам поддержки.
 * true — апдейт наш (дальше его никто не обрабатывает), false — пусть обработает агент товаров.
 */
export declare function handleSupportUpdate(update: SupportTgUpdate): Promise<boolean>;
export {};
