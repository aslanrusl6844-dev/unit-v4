/**
 * Пуш с кодом выдачи покупателю — после POST /courier/request-code, в
 * дополнение к записи pickupCode и SMS (их не заменяет и не ломает).
 * Уходит ТОЛЬКО покупателю этого заказа (токен по его телефону). Канал по
 * формату токена: ExponentPushToken → Expo, иначе FCM-токен → Firebase напрямую
 * (приложение регистрирует именно FCM-токены, через Expo они не доставлялись).
 * Токена нет или отправка не удалась — только в лог, исключение наружу не
 * бросается: pickupCode и SMS от этого не страдают.
 */
export declare function sendPickupCodePush(phone: string, pickupCode: string, orderNumber: string): Promise<void>;
/**
 * Пуш курьеру при «Одобрить» заявки (вкладка «Курьеры» в админке). Токен — из той же таблицы, что и для
 * чата/кода выдачи (ShopCustomerPushToken по нормализованному телефону заявки). Токена нет или отправка
 * не удалась — только в лог, исключение наружу не бросается: одобрение заявки от этого не страдает.
 */
export declare function sendCourierApprovedPush(phone: string): Promise<void>;
/**
 * Пуш покупателю о ходе доставки («Машина выехала», «Машина прибыла в город»). Токен — по нормализованному
 * телефону заказа. Нет токена или отправка не удалась — только в лог: отметка в админке от этого не страдает.
 */
export declare function sendDeliveryProgressPush(phone: string, body: string, orderNumber: string, event: 'shipped' | 'arrived'): Promise<void>;
