import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Отправка SMS через SMSC.kz — единственный провайдер пока
 * (SMS_PROVIDER=smsc). Ключ шлём в теле POST-запроса (не в URL строкой) —
 * он может содержать спецсимволы вроде "$", а form-urlencoded тело всегда
 * кодируется корректно, в отличие от руками собранной query-строки.
 *
 * Сбой шлюза НИКОГДА не бросает исключение наружу — возвращает false,
 * ошибку логирует сам. Вызывающий код (например, /courier/request-code)
 * поэтому не может "сломаться" из-за недоступного SMS-шлюза: код выдачи
 * уже сохранён в заказе до вызова этой функции.
 */
export async function sendSms(phone: string, text: string): Promise<boolean> {
  if (!env.smsApiKey) {
    logger.warn('[SMS] SMS_API_KEY не задан — SMS не отправлено');
    return false;
  }
  if (env.smsProvider !== 'smsc') {
    logger.warn({ provider: env.smsProvider }, '[SMS] Неизвестный SMS_PROVIDER — SMS не отправлено (поддерживается только "smsc")');
    return false;
  }

  try {
    const params = new URLSearchParams({
      apikey: env.smsApiKey,
      phones: phone,
      mes: text,
      charset: 'utf-8',
    });
    const res = await fetch('https://smsc.kz/sys/send.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    const bodyText = await res.text();
    if (!res.ok) {
      logger.error({ status: res.status, bodyText }, '[SMS] Шлюз SMSC ответил HTTP-ошибкой');
      return false;
    }

    // SMSC при ошибке отправки возвращает JSON вида {"error":"...","error_code":N}
    // даже при HTTP 200 — сам HTTP-статус успех отправки не гарантирует.
    let parsed: any = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Не JSON — SMSC в некоторых режимах отвечает простым текстом на
      // успех, считаем это успехом по умолчанию.
    }
    if (parsed?.error) {
      logger.error({ smscError: parsed.error, errorCode: parsed.error_code, phone }, '[SMS] Шлюз SMSC вернул ошибку');
      return false;
    }

    return true;
  } catch (err: any) {
    logger.error({ err, phone }, '[SMS] Не удалось отправить SMS — сбой сети или шлюза');
    return false;
  }
}
