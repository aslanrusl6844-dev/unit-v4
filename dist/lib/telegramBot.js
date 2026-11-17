"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = void 0;
exports.webhookSecret = webhookSecret;
exports.allowedChatIds = allowedChatIds;
exports.isAllowedChat = isAllowedChat;
exports.sendMessage = sendMessage;
exports.sendMessageWithId = sendMessageWithId;
exports.sendPhotos = sendPhotos;
exports.answerCallback = answerCallback;
exports.downloadFile = downloadFile;
exports.setWebhook = setWebhook;
const crypto_1 = require("crypto");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
/** Секрет вебхука выводится из токена бота — отдельная переменная окружения не нужна. */
function webhookSecret() {
    return (0, crypto_1.createHash)('sha256').update('tg-webhook:' + env_1.env.telegramBotToken).digest('hex').slice(0, 32);
}
function allowedChatIds() {
    return env_1.env.telegramChatIds.split(',').map((s) => s.trim()).filter(Boolean);
}
function isAllowedChat(chatId) {
    return allowedChatIds().includes(String(chatId));
}
async function call(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${env_1.env.telegramBotToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
        logger_1.logger.error({ method, status: res.status, telegramError: data?.description }, '[TelegramBot] ответ не ok');
        throw new Error(`telegram ${method}: ${data?.description ?? res.status}`);
    }
    return data.result;
}
async function sendMessage(chatId, text, buttons) {
    await call('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
}
/** Как sendMessage, но возвращает message_id — чтобы потом узнать, на какое сообщение ответили реплаем. */
async function sendMessageWithId(chatId, text, buttons) {
    const result = await call('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    return Number(result?.message_id ?? 0);
}
/** Присылает 1–10 картинок по URL (альбомом). */
async function sendPhotos(chatId, urls) {
    if (urls.length === 1)
        return void (await call('sendPhoto', { chat_id: chatId, photo: urls[0] }));
    await call('sendMediaGroup', { chat_id: chatId, media: urls.slice(0, 10).map((u) => ({ type: 'photo', media: u })) });
}
async function answerCallback(id, text) {
    await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => undefined);
}
/** Скачивает файл из Telegram по file_id. */
async function downloadFile(fileId) {
    const info = await call('getFile', { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${env_1.env.telegramBotToken}/${info.file_path}`);
    if (!res.ok)
        throw new Error(`telegram file ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
}
async function setWebhook(url) {
    await call('setWebhook', {
        url,
        secret_token: webhookSecret(),
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
    });
}
const escapeHtml = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
exports.escapeHtml = escapeHtml;
//# sourceMappingURL=telegramBot.js.map