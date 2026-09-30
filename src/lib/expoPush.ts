import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TIMEOUT_MS = 5000;

/**
 * Пуш с кодом выдачи покупателю — после POST /courier/request-code, в
 * дополнение к записи pickupCode и SMS (их не заменяет и не ломает).
 * Токена нет или Expo ответил ошибкой — только в лог, эта функция никогда
 * не бросает исключение наружу. Ключ Expo для обычной отправки не нужен —
 * запрос идёт без авторизации, как в документации Expo Push API.
 */
export async function sendPickupCodePush(phone: string, pickupCode: string, orderNumber: string): Promise<void> {
  try {
    const record = await prisma.shopCustomerPushToken.findUnique({ where: { phone } });
    if (!record?.token) {
      logger.info({ phone }, '[ExpoPush] Токен покупателя не зарегистрирован — пуш не отправлен');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPO_PUSH_TIMEOUT_MS);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          to: record.token,
          title: 'My Market',
          body: `Код выдачи ${pickupCode}. Назовите только курьеру. Заказ ${orderNumber}`,
          data: { type: 'pickup_code', orderNumber, pickupCode },
          badge: 1,
          sound: 'default',
        }),
        signal: controller.signal,
      });
      const data: any = await res.json().catch(() => ({}));
      // Expo при успехе отдаёт {data:{status:'ok',...}} (одиночное сообщение)
      // или {data:[{status:'ok'|'error',...}]} (массив) — проверяем оба варианта.
      const ticket = Array.isArray(data?.data) ? data.data[0] : data?.data;
      if (!res.ok || data?.errors || ticket?.status === 'error') {
        logger.error(
          { status: res.status, expoError: data?.errors ?? ticket?.message ?? ticket?.details },
          '[ExpoPush] Ответ Expo не ok',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    logger.error({ err: String(err?.message ?? err) }, '[ExpoPush] sendPickupCodePush упал');
  }
}
