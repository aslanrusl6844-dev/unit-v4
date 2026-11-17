/** Заказ, как он приходит из ShopOrder — только поля, реально нужные для уведомления. */
export interface TelegramOrderInput {
    id: string;
    number: string;
    status: string;
    total: number;
    items: string;
    city: string;
    street: string;
    house: string;
    apartment: string | null;
    phone: string;
    telegramMessages: string | null;
}
/**
 * Служебная проверка настройки Telegram — шлёт одну строку во все настроенные
 * чаты. Токен нигде не возвращается и не логируется (у telegramApi тоже).
 * Нет TELEGRAM_BOT_TOKEN — сразу { ok:false, error:'no_token' }, без попытки
 * достучаться до API.
 */
export declare function sendTelegramTestMessage(): Promise<{
    ok: boolean;
    chatCount: number;
    error?: string;
}>;
/**
 * Новое сообщение о заказе — одно на chat_id, photo если есть https-картинка
 * первого товара, иначе просто текст. message_id по каждому chat_id
 * сохраняется в ShopOrder.telegramMessages, чтобы потом править то же
 * сообщение (editOrderNotify), а не слать новое. Нет TELEGRAM_BOT_TOKEN —
 * молча ничего не делает. Любая ошибка — только в лог, заказ уже создан
 * до вызова этой функции и её результат на это никак не влияет.
 */
export declare function sendOrderNotify(order: TelegramOrderInput): Promise<void>;
/**
 * Правит уже отправленное сообщение (по сохранённым message_id) вместо
 * отправки нового — статус paid показывает «Оплачен», cancelled зачёркивает
 * номер и позиции и добавляет «ОТМЕНЁН» сверху. Молча ничего не делает без
 * токена или если для заказа не сохранено ни одного message_id (например,
 * сообщение при создании не отправилось). Ошибки — только в лог.
 */
export declare function editOrderNotify(order: TelegramOrderInput, status: 'paid' | 'cancelled'): Promise<void>;
