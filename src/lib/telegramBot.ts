import { createHash } from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/** Секрет вебхука выводится из токена бота — отдельная переменная окружения не нужна. */
export function webhookSecret(): string {
  return createHash('sha256').update('tg-webhook:' + env.telegramBotToken).digest('hex').slice(0, 32);
}

export function allowedChatIds(): string[] {
  return env.telegramChatIds.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isAllowedChat(chatId: string | number): boolean {
  return allowedChatIds().includes(String(chatId));
}

export type InlineButton = { text: string; callback_data: string };

async function call(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    logger.error({ method, status: res.status, telegramError: data?.description }, '[TelegramBot] ответ не ok');
    throw new Error(`telegram ${method}: ${data?.description ?? res.status}`);
  }
  return data.result;
}

export async function sendMessage(chatId: string, text: string, buttons?: InlineButton[][]): Promise<void> {
  await call('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export async function answerCallback(id: string, text?: string): Promise<void> {
  await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => undefined);
}

/** Скачивает файл из Telegram по file_id. */
export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const info = await call('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.telegramBotToken}/${info.file_path}`);
  if (!res.ok) throw new Error(`telegram file ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
}

export async function setWebhook(url: string): Promise<void> {
  await call('setWebhook', {
    url,
    secret_token: webhookSecret(),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

export const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
