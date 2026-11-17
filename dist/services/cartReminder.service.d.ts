/**
 * Напоминания как в Coupang — сервер шлёт сам, раз в сутки (Vercel Cron):
 *  - cart: товар лежит в корзине больше 2 суток (окно 48–72 ч), заказа нет → «Аслан, вы оставили …»;
 *  - view: товар смотрели сутки назад (окно 24–48 ч), не положили в корзину и не купили → «Аслан, вы смотрели …».
 * Корзина живёт в приложении; сервер видит события аналитики ShopEvent(type=cart|view, sku, phone).
 *
 * Правила (для обоих видов):
 *  - по каждому номеру берём последнее событие вида; если оно свежее начала окна — человек активен, ждём;
 *  - после события у номера был заказ (не отменённый) или оплата → не шлём; для view — ещё и «в корзину» после просмотра;
 *  - номеру за последние 24 ч уже было любое напоминание → не шлём (не больше одного пуша в сутки);
 *  - товар не найден / не в продаже / нет в наличии / нет токена пуша → не шлём;
 *  - честно: скидка — только если есть старая цена; «осталось N шт.» — только если остаток реально ≤ 3;
 *  - в пуше картинка товара; data: type=cart_reminder|view_reminder, screen=product, productId/sku/shopArticle.
 */
export type ReminderKind = 'cart' | 'view';
export declare function discountPercent(price: unknown, oldPrice: unknown): number | null;
/** Короткое название для пуша: до запятой/скобки, не больше 4 слов и ~32 символов («Соковыжималка 1200 Вт центробежная…» → «Соковыжималка 1200 Вт центробежная»). */
export declare function shortName(name: string): string;
/**
 * Текст пуша. С большой картинкой Android показывает только ~2 строки (≈70 знаков), поэтому скидку
 * не повторяем — она уже в заголовке; в тексте только имя, товар и одно короткое действие.
 */
export declare function reminderText(name: string, _pct: number | null, opts?: {
    kind?: ReminderKind;
    firstName?: string | null;
    stock?: number | null;
}): string;
/** Заголовок пуша: как у Coupang — сразу выгода (название приложения телефон пишет сам). */
export declare function reminderTitle(kind: ReminderKind, pct: number | null): string;
/** Имя из последнего заказа номера («Аслан Тушкеев» → «Аслан»); нет заказов — без имени. */
export declare function firstNameOf(customerName: unknown): string | null;
export interface CartReminderResult {
    candidates: number;
    sent: number;
    skipped: number;
    failed: number;
}
/** Оба вида за один запуск: сначала корзина, потом просмотры (один пуш в сутки на номер). */
export declare function runCartReminders(now?: Date): Promise<CartReminderResult>;
export declare function runReminderKind(kind: ReminderKind, now?: Date): Promise<CartReminderResult>;
/**
 * Пробный пуш из админки (Рассылка → «Пример напоминания»): последний просмотренный / положенный в корзину
 * товар номера, без окон по времени и без записи в журнал — чтобы увидеть, как выглядит настоящее напоминание.
 */
export declare function sendTestReminder(kind: ReminderKind, rawPhone: string): Promise<{
    ok: boolean;
    message: string;
}>;
