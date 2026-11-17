/**
 * Подбаннерные витрины — АДМИНИСТРАТИВНАЯ часть. Путь: /api/shop-admin/showcases/...
 *
 * Защита: общий вход администратора (Basic, src/middleware/adminAuth.ts) закрывает
 * весь /api/shop-admin/* по умолчанию — здесь отдельной проверки нет и ключ
 * приложения x-app-key к этим маршрутам отношения не имеет.
 *
 * Товары каталога тут НИКОГДА не создаются, не меняются и не удаляются: витрина
 * хранит только явные ссылки (productId) на существующие товары. Удаление витрины,
 * подборки или привязки удаляет только ссылки.
 */
export declare const showcasesAdminRouter: import("express-serve-static-core").Router;
/** Размер шрифта бегущей строки, sp. */
export declare const TICKER_SIZE_MIN = 8;
export declare const TICKER_SIZE_MAX = 60;
/** Лимиты, чтобы страница витрины для приложения не раздувалась. */
export declare const MAX_PRODUCTS_PER_LIST = 500;
export declare const MAX_COLLECTIONS_PER_SHOWCASE = 30;
/** Список кодов из текста/массива: разделители — перевод строки, запятая, точка с запятой; повторы убираются. */
export declare function parseCodes(raw: string | string[]): string[];
