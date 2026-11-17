"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPickupCodePush = sendPickupCodePush;
exports.sendCourierApprovedPush = sendCourierApprovedPush;
exports.sendDeliveryProgressPush = sendDeliveryProgressPush;
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const pushBroadcast_service_1 = require("../services/pushBroadcast.service");
/**
 * Пуш с кодом выдачи покупателю — после POST /courier/request-code, в
 * дополнение к записи pickupCode и SMS (их не заменяет и не ломает).
 * Уходит ТОЛЬКО покупателю этого заказа (токен по его телефону). Канал по
 * формату токена: ExponentPushToken → Expo, иначе FCM-токен → Firebase напрямую
 * (приложение регистрирует именно FCM-токены, через Expo они не доставлялись).
 * Токена нет или отправка не удалась — только в лог, исключение наружу не
 * бросается: pickupCode и SMS от этого не страдают.
 */
async function sendPickupCodePush(phone, pickupCode, orderNumber) {
    try {
        const record = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
        if (!record?.token) {
            logger_1.logger.info({ phone }, '[PickupPush] Токен покупателя не зарегистрирован — пуш не отправлен');
            return;
        }
        const r = await (0, pushBroadcast_service_1.sendBroadcast)({
            title: 'My Market',
            body: `Код выдачи: ${pickupCode}`,
            tokens: [record.token],
            data: { type: 'pickup_code', orderNumber: String(orderNumber), pickupCode: String(pickupCode) },
        });
        if (r.sent < 1)
            logger_1.logger.error({ failed: r.failed, notRegistered: r.notRegistered, fcmError: r.fcmError }, '[PickupPush] Пуш с кодом выдачи не принят');
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[PickupPush] sendPickupCodePush упал');
    }
}
/**
 * Пуш курьеру при «Одобрить» заявки (вкладка «Курьеры» в админке). Токен — из той же таблицы, что и для
 * чата/кода выдачи (ShopCustomerPushToken по нормализованному телефону заявки). Токена нет или отправка
 * не удалась — только в лог, исключение наружу не бросается: одобрение заявки от этого не страдает.
 */
async function sendCourierApprovedPush(phone) {
    try {
        const record = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
        if (!record?.token) {
            logger_1.logger.info({ phone }, '[CourierApprovedPush] Токен не зарегистрирован — одобрено без пуша');
            return;
        }
        const r = await (0, pushBroadcast_service_1.sendBroadcast)({
            title: 'My Market',
            body: 'Ваша заявка на курьера одобрена. Откройте «Я курьер» и заполните данные.',
            tokens: [record.token],
            data: { type: 'courier_approved' },
        });
        if (r.sent < 1)
            logger_1.logger.error({ failed: r.failed, notRegistered: r.notRegistered, fcmError: r.fcmError }, '[CourierApprovedPush] Пуш не принят');
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[CourierApprovedPush] sendCourierApprovedPush упал');
    }
}
/**
 * Пуш покупателю о ходе доставки («Машина выехала», «Машина прибыла в город»). Токен — по нормализованному
 * телефону заказа. Нет токена или отправка не удалась — только в лог: отметка в админке от этого не страдает.
 */
async function sendDeliveryProgressPush(phone, body, orderNumber, event) {
    try {
        const record = await prisma_1.prisma.shopCustomerPushToken.findUnique({ where: { phone } });
        if (!record?.token) {
            logger_1.logger.info({ phone }, '[DeliveryPush] Токен покупателя не зарегистрирован — пуш не отправлен');
            return;
        }
        const r = await (0, pushBroadcast_service_1.sendBroadcast)({
            title: 'My Market',
            body,
            tokens: [record.token],
            data: { type: 'delivery_' + event, orderNumber: String(orderNumber) },
        });
        if (r.sent < 1)
            logger_1.logger.error({ failed: r.failed, notRegistered: r.notRegistered, fcmError: r.fcmError }, '[DeliveryPush] Пуш не принят');
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[DeliveryPush] sendDeliveryProgressPush упал');
    }
}
//# sourceMappingURL=expoPush.js.map