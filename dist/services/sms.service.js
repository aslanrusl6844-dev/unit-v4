"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSms = sendSms;
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
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
async function sendSms(phone, text) {
    if (!env_1.env.smsApiKey) {
        logger_1.logger.warn('[SMS] SMS_API_KEY не задан — SMS не отправлено');
        return false;
    }
    if (env_1.env.smsProvider !== 'smsc') {
        logger_1.logger.warn({ provider: env_1.env.smsProvider }, '[SMS] Неизвестный SMS_PROVIDER — SMS не отправлено (поддерживается только "smsc")');
        return false;
    }
    try {
        const params = new URLSearchParams({
            apikey: env_1.env.smsApiKey,
            phones: phone,
            mes: text,
            charset: 'utf-8',
            fmt: '3', // ответ в JSON: {"id","cnt"} или {"error","error_code"} — иначе SMSC отвечает простым текстом
        });
        const res = await fetch('https://smsc.kz/sys/send.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
        });
        const bodyText = await res.text();
        if (!res.ok) {
            logger_1.logger.error({ status: res.status, bodyText }, '[SMS] Шлюз SMSC ответил HTTP-ошибкой');
            return false;
        }
        // SMSC при ошибке отправки возвращает JSON вида {"error":"...","error_code":N}
        // даже при HTTP 200 — сам HTTP-статус успех отправки не гарантирует.
        let parsed = null;
        try {
            parsed = JSON.parse(bodyText);
        }
        catch {
            // Не JSON — SMSC в некоторых режимах отвечает простым текстом на
            // успех, считаем это успехом по умолчанию.
        }
        if (parsed?.error) {
            logger_1.logger.error({ smscError: parsed.error, errorCode: parsed.error_code, phone }, '[SMS] Шлюз SMSC вернул ошибку');
            return false;
        }
        // Текстовый ответ об ошибке («ERROR = 2 (...)») раньше считался успехом — SMS «отправлено», а до телефона не дошло.
        if (!parsed && /^\s*ERROR\b/i.test(bodyText)) {
            logger_1.logger.error({ smscError: bodyText.slice(0, 200), phone }, '[SMS] Шлюз SMSC вернул ошибку (текст)');
            return false;
        }
        logger_1.logger.info({ phone: phone.slice(-4), smsc: bodyText.slice(0, 120) }, '[SMS] Шлюз SMSC принял сообщение');
        return true;
    }
    catch (err) {
        logger_1.logger.error({ err, phone }, '[SMS] Не удалось отправить SMS — сбой сети или шлюза');
        return false;
    }
}
//# sourceMappingURL=sms.service.js.map