/**
 * Чат с оператором из чата Баурсака. Смонтирован внутри assistantRouter (/api/shop/assistant/support),
 * x-app-key проверяется там. Каждый чат защищён своим токеном: его выдаёт /start, приложение
 * передаёт его в заголовке x-support-token.
 */
export declare const supportRouter: import("express-serve-static-core").Router;
