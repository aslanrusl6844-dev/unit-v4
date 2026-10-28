import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { sendBroadcast } from '../services/pushBroadcast.service';

/**
 * Пуш с кодом выдачи покупателю — после POST /courier/request-code, в
 * дополнение к записи pickupCode и SMS (их не заменяет и не ломает).
 * Уходит ТОЛЬКО покупателю этого заказа (токен по его телефону). Канал по
 * формату токена: ExponentPushToken → Expo, иначе FCM-токен → Firebase напрямую
 * (приложение регистрирует именно FCM-токены, через Expo они не доставлялись).
 * Токена нет или отправка не удалась — только в лог, исключение наружу не
 * бросается: pickupCode и SMS от этого не страдают.
 */
export async function sendPickupCodePush(phone: string, pickupCode: string, orderNumber: string): Promise<void> {
  try {
    const record = await prisma.shopCustomerPushToken.findUnique({ where: { phone } });
    if (!record?.token) {
      logger.info({ phone }, '[PickupPush] Токен покупателя не зарегистрирован — пуш не отправлен');
      return;
    }
    const r = await sendBroadcast({
      title: 'My Market',
      body: `Код выдачи: ${pickupCode}`,
      tokens: [record.token],
      data: { type: 'pickup_code', orderNumber: String(orderNumber), pickupCode: String(pickupCode) },
    });
    if (r.sent < 1) logger.error({ failed: r.failed, notRegistered: r.notRegistered, fcmError: r.fcmError }, '[PickupPush] Пуш с кодом выдачи не принят');
  } catch (err: any) {
    logger.error({ err: String(err?.message ?? err) }, '[PickupPush] sendPickupCodePush упал');
  }
}
