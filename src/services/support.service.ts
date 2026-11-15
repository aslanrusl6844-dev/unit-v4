/**
 * Чат с живым оператором из чата Баурсака.
 *
 * Покупатель в приложении второй раз просит оператора → приложение открывает чат поддержки (POST /start).
 * Оператору в Telegram (тот же бот, разрешённые чаты TELEGRAM_CHAT_IDS) приходит запрос с кнопками
 * «Взять» / «Завершить». Оператор отвечает реплаем на сообщение чата (или «#номер текст») —
 * ответ попадает в приложение покупателю, приходит пуш «Оператор ответил».
 * «Завершить» — чат закрывается, дальше снова отвечает Баурсак.
 */
import { randomBytes } from 'crypto';
import { waitUntil } from '@vercel/functions';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { allowedChatIds, answerCallback, escapeHtml, isAllowedChat, sendMessage, sendMessageWithId, webhookSecret } from '../lib/telegramBot';
import { sendBroadcast } from './pushBroadcast.service';

export type SupportStatus = 'waiting' | 'active' | 'closed';
export const MAX_TEXT = 2000;
/** Клиент не ответил столько после сообщения оператора — чат с оператором закрывается сам. */
export const IDLE_MS = 60_000;
export const IDLE_TEXT = 'Чат с оператором завершён: вы не ответили в течение минуты. Если вопрос остался — напишите, Баурсак на связи 🙂';

let baseUrl = '';
/** Адрес этого же сервера (ставит вебхук бота) — для проверки «клиент молчит минуту» отдельным вызовом. */
export function setSupportBaseUrl(url: string) { if (url) baseUrl = url; }

/** Просит ли клиент живого человека. Приложение соединяет только со второй такой просьбы. */
export function isOperatorRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /оператор|менеджер|живо(й|го|му) (человек|сотрудник|консультант)|соедини|позовите|поддержк|operator|support|human|оператормен|қолдау/.test(t);
}

type HistoryItem = { fromUser: boolean; text: string };

function cleanText(raw: unknown): string {
  return String(raw ?? '').replace(/\r/g, '').trim().slice(0, MAX_TEXT);
}

function who(chat: { customerName?: string | null; phone?: string | null }): string {
  const name = chat.customerName?.trim();
  const phone = chat.phone?.trim();
  return [name, phone ? `+${phone.replace(/^\+/, '')}` : ''].filter(Boolean).join(' · ') || 'Гость';
}

const takeButtons = (id: string) => [[
  { text: '✋ Взять', callback_data: `sup:take:${id}` },
  { text: '✖️ Завершить', callback_data: `sup:close:${id}` },
]];
const closeButtons = (id: string) => [[{ text: '✖️ Завершить чат', callback_data: `sup:close:${id}` }]];

/** Отправляет сообщение операторам и запоминает его id, чтобы ловить ответы реплаем. */
async function notifyOperators(chatId: string, text: string, targets: string[], buttons?: { text: string; callback_data: string }[][]): Promise<void> {
  for (const tg of targets) {
    try {
      const messageId = await sendMessageWithId(tg, text, buttons);
      if (messageId) await prisma.supportTgRef.create({ data: { supportChatId: chatId, tgChatId: tg, tgMessageId: messageId } });
    } catch (err: any) {
      logger.warn({ err: String(err?.message ?? err), tg }, '[Support] не удалось отправить оператору');
    }
  }
}

/** Пуш покупателю. Ошибки не мешают основному действию. */
async function pushCustomer(chat: { id: string; phone?: string | null; pushToken?: string | null }, title: string, body: string): Promise<void> {
  try {
    let token = chat.pushToken?.trim() || '';
    if (!token && chat.phone) {
      const device = await prisma.shopCustomerPushToken.findUnique({ where: { phone: chat.phone } });
      token = device?.token ?? '';
    }
    if (!token) return;
    await sendBroadcast({ title, body: body.slice(0, 180), tokens: [token], data: { type: 'support', chatId: chat.id } });
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, '[Support] пуш покупателю не ушёл');
  }
}

type IdleFields = { status: string; lastOperatorAt?: Date | null; lastCustomerAt?: Date | null };

/** Оператор написал, клиент после этого молчит дольше IDLE_MS. */
export function idleExpired(chat: IdleFields, now = Date.now()): boolean {
  if (chat.status !== 'active' || !chat.lastOperatorAt) return false;
  const op = new Date(chat.lastOperatorAt).getTime();
  if (chat.lastCustomerAt && new Date(chat.lastCustomerAt).getTime() >= op) return false;
  return now - op >= IDLE_MS;
}

/** Закрывает чат, если клиент молчит минуту после оператора. true — закрыли сейчас. */
export async function closeIfIdle(chatId: string, now = Date.now()): Promise<boolean> {
  const chat = await prisma.supportChat.findUnique({ where: { id: chatId } });
  if (!chat || !idleExpired(chat, now)) return false;
  // Атомарно и только если за это время никто ничего не написал.
  const r = await prisma.supportChat.updateMany({
    where: { id: chat.id, status: 'active', lastOperatorAt: chat.lastOperatorAt },
    data: { status: 'closed', closedAt: new Date(now), closedBy: 'timeout' },
  });
  if (!r.count) return false;
  await prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: IDLE_TEXT } });
  await pushCustomer(chat, 'Чат с оператором завершён', 'Вы не ответили в течение минуты. Баурсак на связи');
  const targets = chat.operatorTgChatId ? [chat.operatorTgChatId] : allowedChatIds();
  for (const tg of targets) await sendMessage(tg, `⚪️ Чат #${chat.number} закрыт автоматически: клиент не ответил 1 минуту.`).catch(() => undefined);
  logger.info({ number: chat.number }, '[Support] чат закрыт по тишине клиента');
  return true;
}

/**
 * Через минуту после сообщения оператора проверяет, ответил ли клиент. Функция на Vercel живёт до 60 с,
 * поэтому ожидание идёт отдельным вызовом этого же сервера (/api/telegram-agent/support-idle).
 * Нет адреса сервера — чат всё равно закроется при следующем обращении (опрос приложения, сообщение).
 */
function scheduleIdleCheck(chatId: string): void {
  if (!baseUrl) return;
  waitUntil(
    fetch(`${baseUrl}/api/telegram-agent/support-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret() },
      body: JSON.stringify({ chatId }),
      signal: AbortSignal.timeout(10_000),
    }).then(() => undefined).catch((err) => logger.warn({ err: String(err?.message ?? err) }, '[Support] не удалось запланировать проверку тишины')),
  );
}

/**
 * Вызов /support-idle: ждёт, пока выйдет минута тишины (не дольше ~45 с за вызов, иначе передаёт
 * ожидание следующему вызову), и закрывает чат, если клиент так и не ответил.
 */
export async function runIdleCheck(chatId: string): Promise<void> {
  const chat = await prisma.supportChat.findUnique({ where: { id: chatId } });
  if (!chat || chat.status !== 'active' || !chat.lastOperatorAt) return;
  const dueAt = new Date(chat.lastOperatorAt).getTime() + IDLE_MS + 1_000;
  const wait = dueAt - Date.now();
  if (wait > 45_000) {
    await new Promise((r) => setTimeout(r, 40_000));
    scheduleIdleCheck(chatId);
    return;
  }
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await closeIfIdle(chatId);
}

export interface StartInput {
  phone?: string | null;
  customerName?: string | null;
  pushToken?: string | null;
  question?: string | null;
  history?: unknown;
}

export async function startChat(input: StartInput) {
  const phone = String(input.phone ?? '').replace(/\D/g, '').slice(0, 15) || null;
  const chat = await prisma.supportChat.create({
    data: {
      token: randomBytes(24).toString('hex'),
      phone,
      customerName: cleanText(input.customerName).slice(0, 80) || null,
      pushToken: cleanText(input.pushToken).slice(0, 400) || null,
      status: 'waiting',
    },
  });
  const question = cleanText(input.question);
  const greeting = 'Соединяю с оператором. Обычно отвечаем в течение нескольких минут — можно пока описать вопрос подробнее.';
  await prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: greeting } });

  // Последние реплики разговора с Баурсаком — оператору не придётся переспрашивать.
  const history: HistoryItem[] = Array.isArray(input.history)
    ? (input.history as any[])
      .filter((m) => m && typeof m.text === 'string' && m.text.trim())
      .map((m) => ({ fromUser: !!m.fromUser, text: String(m.text).replace(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/g, '').trim().slice(0, 300) }))
      .filter((m) => m.text)
      .slice(-8)
    : [];
  const parts = [`🟢 <b>Новый чат #${chat.number}</b> · ${escapeHtml(who(chat))}`];
  if (question) parts.push(`Вопрос: ${escapeHtml(question)}`);
  if (history.length) parts.push('', '<b>Разговор с Баурсаком:</b>', ...history.map((m) => `${m.fromUser ? '👤' : '🥯'} ${escapeHtml(m.text)}`));
  parts.push('', `Нажмите «Взять» и отвечайте реплаем на это сообщение (или пишите «#${chat.number} текст»).`);
  await notifyOperators(chat.id, parts.join('\n'), allowedChatIds(), takeButtons(chat.id));
  logger.info({ number: chat.number }, '[Support] новый чат');
  return chat;
}

async function chatByToken(id: string, token: string) {
  if (!id || !token) return null;
  const chat = await prisma.supportChat.findUnique({ where: { id } });
  if (!chat || chat.token !== token) return null;
  return chat;
}

export type CustomerResult = { ok: true; message: any } | { ok: false; code: 404 | 409 | 400; error: string };

export async function customerMessage(id: string, token: string, rawText: unknown): Promise<CustomerResult> {
  const chat = await chatByToken(id, token);
  if (!chat) return { ok: false, code: 404, error: 'Чат не найден' };
  if (chat.status === 'closed' || (await closeIfIdle(chat.id))) return { ok: false, code: 409, error: 'Чат с оператором завершён' };
  const text = cleanText(rawText);
  if (!text) return { ok: false, code: 400, error: 'Пустое сообщение' };
  const message = await prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'customer', text } });
  await prisma.supportChat.update({ where: { id: chat.id }, data: { lastCustomerAt: new Date() } });
  const targets = chat.status === 'active' && chat.operatorTgChatId ? [chat.operatorTgChatId] : allowedChatIds();
  await notifyOperators(
    chat.id,
    `💬 <b>#${chat.number}</b> · ${escapeHtml(who(chat))}:\n${escapeHtml(text)}`,
    targets,
    chat.status === 'waiting' ? takeButtons(chat.id) : undefined,
  );
  return { ok: true, message };
}

export async function chatState(id: string, token: string, after = 0) {
  let chat = await chatByToken(id, token);
  if (!chat) return null;
  if (await closeIfIdle(chat.id)) chat = (await chatByToken(id, token)) ?? chat;
  const messages = await prisma.supportMessage.findMany({
    where: { chatId: chat.id, id: { gt: Math.max(0, Math.floor(after) || 0) } },
    orderBy: { id: 'asc' },
    take: 100,
  });
  return {
    id: chat.id,
    number: chat.number,
    status: chat.status as SupportStatus,
    operatorName: chat.operatorName,
    messages: messages.map((m: any) => ({ id: m.id, sender: m.sender, text: m.text, operatorName: m.operatorName, createdAt: m.createdAt })),
  };
}

export async function closeByCustomer(id: string, token: string): Promise<boolean> {
  const chat = await chatByToken(id, token);
  if (!chat) return false;
  if (chat.status === 'closed') return true;
  await prisma.supportChat.update({ where: { id: chat.id }, data: { status: 'closed', closedAt: new Date(), closedBy: 'customer' } });
  await prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: 'Вы завершили чат с оператором. Дальше снова отвечает Баурсак.' } });
  const targets = chat.operatorTgChatId ? [chat.operatorTgChatId] : allowedChatIds();
  for (const tg of targets) await sendMessage(tg, `⚪️ Покупатель завершил чат #${chat.number}.`).catch(() => undefined);
  return true;
}

// ---------------------------------------------------------------------------
// Telegram: ответы операторов
// ---------------------------------------------------------------------------

export type SupportTgUpdate = {
  message?: {
    message_id?: number;
    chat: { id: number };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: { id: string; data?: string; from?: { id: number; first_name?: string }; message?: { chat: { id: number } } };
};

function operatorNameOf(from?: { first_name?: string; username?: string }): string {
  return (from?.first_name || from?.username || 'Оператор').trim().slice(0, 40);
}

async function take(chatId: string, tgChatId: string, operatorName: string, silentIfMine = false): Promise<any | null> {
  const chat = await prisma.supportChat.findUnique({ where: { id: chatId } });
  if (!chat) return null;
  if (chat.status === 'closed') {
    await sendMessage(tgChatId, `Чат #${chat.number} уже завершён.`).catch(() => undefined);
    return null;
  }
  if (chat.status === 'active' && chat.operatorTgChatId && chat.operatorTgChatId !== tgChatId) {
    await sendMessage(tgChatId, `Чат #${chat.number} уже взял(а) ${escapeHtml(chat.operatorName ?? 'другой оператор')}.`).catch(() => undefined);
    return null;
  }
  if (chat.status === 'active') {
    if (!silentIfMine) await sendMessage(tgChatId, `Чат #${chat.number} уже ваш.`).catch(() => undefined);
    return chat;
  }
  // Атомарно: взять может только один оператор.
  const r = await prisma.supportChat.updateMany({
    where: { id: chat.id, status: 'waiting' },
    data: { status: 'active', operatorName, operatorTgChatId: tgChatId },
  });
  if (!r.count) return take(chatId, tgChatId, operatorName, silentIfMine);
  await prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'system', text: `${operatorName} подключился(ась) к чату`, operatorName } });
  await pushCustomer(chat, 'Оператор на связи', `${operatorName} подключился(ась) к чату`);
  await notifyOperators(
    chat.id,
    `✅ Вы взяли чат <b>#${chat.number}</b> · ${escapeHtml(who(chat))}.\nОтвечайте реплаем на сообщения этого чата или «#${chat.number} текст».`,
    [tgChatId],
    closeButtons(chat.id),
  );
  // Остальным операторам — что чат занят.
  for (const tg of allowedChatIds()) {
    if (tg !== tgChatId) await sendMessage(tg, `Чат #${chat.number} взял(а) ${escapeHtml(operatorName)}.`).catch(() => undefined);
  }
  return { ...chat, status: 'active', operatorName, operatorTgChatId: tgChatId };
}

async function closeByOperator(chatId: string, tgChatId: string, operatorName: string): Promise<void> {
  const chat = await prisma.supportChat.findUnique({ where: { id: chatId } });
  if (!chat) return;
  if (chat.status === 'closed') {
    await sendMessage(tgChatId, `Чат #${chat.number} уже завершён.`).catch(() => undefined);
    return;
  }
  await prisma.supportChat.update({ where: { id: chat.id }, data: { status: 'closed', closedAt: new Date(), closedBy: 'operator' } });
  await prisma.supportMessage.create({
    data: { chatId: chat.id, sender: 'system', text: 'Оператор завершил чат. Если остались вопросы — пишите, дальше снова отвечает Баурсак 🙂', operatorName },
  });
  await pushCustomer(chat, 'Чат с оператором завершён', 'Если остались вопросы — Баурсак на связи');
  await sendMessage(tgChatId, `⚪️ Чат #${chat.number} завершён.`).catch(() => undefined);
}

async function operatorReply(chatId: string, tgChatId: string, operatorName: string, rawText: string): Promise<void> {
  const text = cleanText(rawText);
  if (!text) return;
  if (await closeIfIdle(chatId)) return; // клиент уже минуту молчал — чат закрыт, оператору ушло уведомление
  const chat = await take(chatId, tgChatId, operatorName, true);
  if (!chat) return;
  await prisma.supportMessage.create({ data: { chatId: chat.id, sender: 'operator', text, operatorName } });
  await prisma.supportChat.update({ where: { id: chat.id }, data: { lastOperatorAt: new Date() } });
  scheduleIdleCheck(chat.id);
  await pushCustomer(chat, `${operatorName} (оператор)`, text);
  await sendMessage(tgChatId, `✓ Отправлено в чат #${chat.number}`).catch(() => undefined);
}

/**
 * Обрабатывает апдейт Telegram, если он относится к чатам поддержки.
 * true — апдейт наш (дальше его никто не обрабатывает), false — пусть обработает агент товаров.
 */
export async function handleSupportUpdate(update: SupportTgUpdate): Promise<boolean> {
  const cb = update.callback_query;
  if (cb?.data?.startsWith('sup:')) {
    const tgChat = cb.message?.chat.id;
    await answerCallback(cb.id);
    if (!tgChat || !isAllowedChat(tgChat)) return true;
    const [, action, id] = cb.data.split(':');
    const name = operatorNameOf(cb.from);
    if (action === 'take' && id) await take(id, String(tgChat), name);
    if (action === 'close' && id) await closeByOperator(id, String(tgChat), name);
    return true;
  }

  const m = update.message;
  if (!m || !m.text || !isAllowedChat(m.chat.id)) return false;
  const tgChat = String(m.chat.id);
  const name = operatorNameOf(m.from);

  // «#125 текст» — ответ в чат по номеру.
  const byNumber = m.text.match(/^#(\d{1,9})\s+([\s\S]+)$/);
  if (byNumber) {
    const chat = await prisma.supportChat.findUnique({ where: { number: Number(byNumber[1]) } });
    if (!chat) {
      await sendMessage(tgChat, `Чата #${byNumber[1]} нет.`).catch(() => undefined);
      return true;
    }
    await operatorReply(chat.id, tgChat, name, byNumber[2]);
    return true;
  }

  // Реплай на сообщение бота, которое относится к чату поддержки.
  const replyTo = m.reply_to_message?.message_id;
  if (replyTo) {
    const ref = await prisma.supportTgRef.findUnique({ where: { tgChatId_tgMessageId: { tgChatId: tgChat, tgMessageId: replyTo } } });
    if (ref) {
      await operatorReply(ref.supportChatId, tgChat, name, m.text);
      return true;
    }
  }
  return false;
}
