import { Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { waitUntil } from '@vercel/functions';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import {
  askOzonManager, daySales, eveningReport, fbsToShip, fboStock, morningReport, photoCards, purchaseNeeds, returnsList,
  setOzonBotPhotoSender, type PhotoCard,
} from '../services/ozonManager.service';

/**
 * Озон-менеджер — ОТДЕЛЬНЫЙ Telegram-бот (свой токен OZON_BOT_TOKEN), только для владельца
 * (OZON_BOT_OWNER_ID — его chat id). Вебхук: /api/ozon-bot/webhook, защита — секрет из токена.
 */
export const ozonBotRouter = Router();

const token = () => (process.env.OZON_BOT_TOKEN ?? '').trim();
/** Кому бот отвечает: chat id владельца и/или семейной группы (через запятую). Отчёты — в первый. */
const allowedIds = () => (process.env.OZON_BOT_OWNER_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ownerId = () => allowedIds()[0] ?? '';
export const ozonBotSecret = () => createHash('sha256').update('ozon-bot:' + token()).digest('hex').slice(0, 32);

type TgFetch = typeof fetch;
let tgFetch: TgFetch = (...a) => fetch(...a);
export function setOzonBotTelegramFetch(f: TgFetch | null) { tgFetch = f ?? ((...a) => fetch(...a)); }

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const r = await tgFetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) throw new Error(`telegram ${method}: ${data?.description ?? r.status}`);
  return data.result;
}

/** Отправить текст (HTML), длинный — кусками; если Telegram не принял разметку — тем же текстом без неё. */
export async function sendOzonBot(chatId: string, text: string): Promise<void> {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 3900) {
    const cut = rest.lastIndexOf('\n', 3900);
    parts.push(rest.slice(0, cut > 1000 ? cut : 3900));
    rest = rest.slice(cut > 1000 ? cut : 3900);
  }
  parts.push(rest);
  for (const part of parts) {
    try {
      await tg('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true });
    } catch {
      await tg('sendMessage', { chat_id: chatId, text: part.replace(/<[^>]+>/g, ''), disable_web_page_preview: true });
    }
  }
}

/** Фото из Telegram → base64 для Claude (самое большое из размеров, до ~4 МБ). */
async function downloadPhoto(fileId: string): Promise<{ mediaType: string; base64: string }> {
  const f = await tg('getFile', { file_id: fileId });
  const r = await tgFetch(`https://api.telegram.org/file/bot${token()}/${f.file_path}`);
  if (!r.ok) throw new Error(`photo ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 4_500_000) throw new Error('фото слишком большое');
  const ext = String(f.file_path).split('.').pop()?.toLowerCase();
  return { mediaType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', base64: buf.toString('base64') };
}

const escH = (v: string) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Товары фотографиями: одно фото = один товар, подпись — название и КОЛИЧЕСТВО крупно (удобно
 * переслать оптовику). Без фото — одной общей строкой в конце. Закупочные цены в подпись не пишем.
 */
let imgFetch: TgFetch = (...a) => fetch(...a);
export function setOzonBotImageFetch(f: TgFetch | null) { imgFetch = f ?? ((...a) => fetch(...a)); }

/** Скачать фото товара сами (Telegram не всегда может забрать картинку с CDN Ozon по ссылке). */
async function loadImage(url: string): Promise<Blob | null> {
  try {
    const r = await imgFetch(url, { headers: { Accept: 'image/jpeg,image/png,image/*' }, signal: AbortSignal.timeout(8000) } as any);
    if (!r.ok) return null;
    const type = r.headers?.get?.('content-type') ?? 'image/jpeg';
    if (!/^image\/(jpe?g|png|webp)/i.test(type)) return null;
    const buf = await r.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 9_000_000) return null;
    return new Blob([buf], { type });
  } catch {
    return null;
  }
}

/** sendPhoto файлом (multipart) — так фото доходит всегда, если мы смогли его скачать. */
async function sendPhotoFile(chatId: string, img: Blob, caption: string): Promise<void> {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', img, 'item.jpg');
  const r = await tgFetch(`https://api.telegram.org/bot${token()}/sendPhoto`, { method: 'POST', body: form } as any);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) throw new Error(`telegram sendPhoto: ${data?.description ?? r.status}`);
}

export async function sendPhotoCards(chatId: string, title: string, cards: PhotoCard[]): Promise<void> {
  const started = Date.now();
  const total = cards.reduce((s, c) => s + c.qty, 0);
  if (!cards.length) { await sendOzonBot(chatId, `${title}\nПока ничего нет 👍`); return; }
  await sendOzonBot(chatId, `<b>${escH(title)}</b>\n${cards.length} товаров, всего ${total} шт`);
  const noPhoto: PhotoCard[] = [];
  const list = cards.slice(0, 30);
  // Фото качаем заранее, по 5 параллельно, а отправляем по порядку (сначала самые ходовые).
  const images: (Blob | null)[] = new Array(list.length).fill(null);
  for (let i = 0; i < list.length; i += 5) {
    const chunk = list.slice(i, i + 5);
    const got = await Promise.all(chunk.map((c) => (c.photo ? loadImage(c.photo) : Promise.resolve(null))));
    got.forEach((b, j) => { images[i + j] = b; });
    if (Date.now() - started > 30_000) break;
  }
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    // Лимит функции — 60 с: если не успеваем, остальное — списком.
    if (!c.photo || Date.now() - started > 45_000) { noPhoto.push(c); continue; }
    const caption = `<b>${c.qty} шт</b> — ${escH(c.name.slice(0, 180))}${c.offerId ? `\nАртикул: ${escH(c.offerId)}` : ''}`;
    try {
      const img = images[i];
      if (img) await sendPhotoFile(chatId, img, caption);
      else await tg('sendPhoto', { chat_id: chatId, photo: c.photo, caption, parse_mode: 'HTML' });
    } catch (err: any) {
      logger.warn({ err: String(err?.message ?? err), photo: c.photo }, '[OzonBot] фото не отправилось');
      noPhoto.push(c);
    }
  }
  noPhoto.push(...cards.slice(30));
  if (noPhoto.length) {
    await sendOzonBot(chatId, ['<b>Без фото:</b>', ...noPhoto.map((c) => `• <b>${c.qty} шт</b> — ${escH(c.name.slice(0, 120))}${c.offerId ? ` (${escH(c.offerId)})` : ''}`)].join('\n'));
  }
}
setOzonBotPhotoSender(sendPhotoCards);

function secretOk(v: string | undefined): boolean {
  if (!token() || !v) return false;
  const a = Buffer.from(v);
  const b = Buffer.from(ozonBotSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ')} ₸`;

const HELP = [
  '<b>Озон-менеджер</b> 🤖',
  'Спрашивайте обычными словами: «сколько заработали за неделю?», «что отгрузить сегодня?», «какие возвраты?».',
  '',
  '🔎 <b>Анализ товара и конкурентов</b>: пришлите фото товара и подпись — название и себестоимость (например «Блендер Kitfort KT-1365, закупка 9500»). Найду ~10 конкурентов на Ozon, посчитаю маржу и скажу, FBO или FBS.',
  '',
  'Быстрые команды:',
  '/report — утренний отчёт (отгрузки, закупка, возвраты, склады)',
  '/today — продажи и прибыль за сегодня',
  '/ship — что отгрузить и сроки',
  '/buy — сколько нужно на закупку',
  '/collect — что собрать у оптовиков: фото + количество',
  '/sold — что продалось сегодня: фото + количество',
  '/returns — возвраты за 7 дней',
  '/stock — остатки на складах Ozon',
  '/new — начать разговор заново',
].join('\n');

async function quick(cmd: string): Promise<string | null> {
  switch (cmd) {
    case '/report': return morningReport();
    case '/evening': return eveningReport();
    case '/today': {
      const d = await daySales();
      return [`<b>Сегодня (${d.date})</b>`, `FBS: ${d.fbs.orders} заказов на ${money(d.fbs.revenue)}, прибыль ≈ <b>${money(d.fbs.profit)}</b>`,
        d.fbo.count ? `FBO: ${d.fbo.count} на ${money(d.fbo.revenue)}` : '', d.cancelled ? `Отмен: ${d.cancelled}` : '',
        ...d.fbs.list.slice(0, 15).map((x) => `• ${x.posting}: ${money(x.revenue)} → ${money(x.profit)}${x.feesPending ? ' (комиссия ещё не начислена)' : ''}`)]
        .filter(Boolean).join('\n');
    }
    case '/ship': {
      const s = await fbsToShip();
      return [`<b>Отгрузка FBS</b>: ${s.total} (просрочено ${s.overdue}, сегодня ${s.today}, завтра ${s.tomorrow})`,
        ...s.postings.slice(0, 25).map((p) => `${p.bucket === 'overdue' ? '🔴' : p.bucket === 'today' ? '🟠' : '•'} ${p.postingNumber} — до ${p.shipBy ? new Date(p.shipBy).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}${p.needPacking ? ', не собран' : ', сдать'}`)].join('\n');
    }
    case '/buy': {
      const b = await purchaseNeeds();
      return [`<b>Закупка под заказы</b>: ${money(b.totalPurchase)}`,
        ...b.items.slice(0, 25).map((i) => `• ${i.name.slice(0, 60)} — ${i.qty} шт${i.unitCost ? ` × ${money(i.unitCost)} = ${money(i.sum)}` : ' (нет закупочной цены)'}`)].join('\n');
    }
    case '/returns': {
      const r = await returnsList(7);
      return [`<b>Возвраты за 7 дней</b>: ${r.count} на ${money(r.sum)}`,
        ...r.items.slice(0, 20).map((x) => `• ${x.product.slice(0, 50)} — ${x.status}${x.reason ? `, ${x.reason}` : ''}`)].join('\n');
    }
    case '/stock': {
      const s = await fboStock();
      return [`<b>Склады Ozon</b>: ${s.skus} товаров, ${s.totalFree} шт`, `Кончается (≤7 дней): ${s.lowCount}`,
        ...s.low.map((x) => `• ${x.name.slice(0, 50)} — ${x.free} шт, ~${x.daysLeft} дн.`),
        s.outOfStockSelling.length ? `Закончились: ${s.outOfStockSelling.join(', ')}` : ''].filter(Boolean).join('\n');
    }
    default: return null;
  }
}

export async function handleOzonBotUpdate(update: any): Promise<void> {
  const msg = update?.message;
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : '';
  const text: string = String(msg?.text ?? msg?.caption ?? '').trim();
  const photo: any[] | undefined = Array.isArray(msg?.photo) ? msg.photo : undefined;
  if (!chatId || (!text && !photo?.length)) return;
  if (!ownerId()) {
    await sendOzonBot(chatId, `Бот ещё не привязан.\nChat id ${msg?.chat?.type === 'private' ? 'этого чата' : 'этой группы'}: <b>${chatId}</b>\nДобавьте его в Vercel как OZON_BOT_OWNER_ID и сделайте Redeploy.`);
    return;
  }
  if (!allowedIds().includes(chatId)) return; // чужим — молчим
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/start' || cmd === '/help') { await sendOzonBot(chatId, HELP); return; }
  if (cmd === '/new') {
    await prisma.ozonBotMessage.deleteMany({ where: { chatId } });
    await sendOzonBot(chatId, 'Начали заново 👍');
    return;
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
  try {
    if (cmd === '/collect' || cmd === '/sold') {
      const { title, cards } = await photoCards(cmd === '/sold' ? 'sold' : 'collect');
      await sendPhotoCards(chatId, title, cards);
      return;
    }
    const fast = await quick(cmd);
    if (fast !== null) { await sendOzonBot(chatId, fast); return; }
    const rows = await prisma.ozonBotMessage.findMany({ where: { chatId }, orderBy: { createdAt: 'desc' }, take: 10 });
    const history = rows.reverse().map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
    const image = photo?.length ? await downloadPhoto(photo[photo.length - 1].file_id).catch(() => undefined) : undefined;
    if (photo?.length) await sendOzonBot(chatId, '🔎 Смотрю товар и ищу конкурентов на Ozon — это займёт до минуты…');
    // В группе бот видит, кто спрашивает (владелец или жена) — чтобы отвечать по имени.
    const who = msg?.chat?.type !== 'private' && msg?.from?.first_name ? `[${String(msg.from.first_name).slice(0, 30)}] ` : '';
    const answer = await askOzonManager(history, who + text, image, { chatId });
    await prisma.ozonBotMessage.createMany({ data: [{ chatId, role: 'user', content: ((photo?.length ? '[фото товара] ' : '') + text).slice(0, 4000) }, { chatId, role: 'assistant', content: answer.slice(0, 4000) }] });
    await sendOzonBot(chatId, answer);
  } catch (err: any) {
    logger.error({ err: String(err?.message ?? err) }, '[OzonBot] ошибка ответа');
    await sendOzonBot(chatId, `⚠️ Не получилось: ${String(err?.message ?? err).slice(0, 200)}`).catch(() => undefined);
  }
}

ozonBotRouter.post('/webhook', (req, res) => {
  if (!secretOk(req.header('x-telegram-bot-api-secret-token'))) return res.status(401).json({ ok: false });
  res.json({ ok: true }); // Telegram ждёт быстрый ответ; думаем в фоне
  waitUntil(handleOzonBotUpdate(req.body).catch((err) => logger.error({ err: String(err?.message ?? err) }, '[OzonBot] webhook')));
});

/** Админский: один раз привязать бота к этому серверу (setWebhook) и задать меню команд. */
ozonBotRouter.get('/setup', async (req, res) => {
  if (!token()) return res.status(503).json({ error: 'OZON_BOT_TOKEN не настроен в Vercel' });
  const host = req.header('x-forwarded-host') || req.header('host');
  const url = `https://${host}/api/ozon-bot/webhook`;
  try {
    await tg('setWebhook', { url, secret_token: ozonBotSecret(), allowed_updates: ['message'], drop_pending_updates: true });
    await tg('setMyCommands', { commands: [
      { command: 'report', description: 'Утренний отчёт' }, { command: 'today', description: 'Продажи за сегодня' },
      { command: 'ship', description: 'Что отгрузить' }, { command: 'buy', description: 'Закупка под заказы' },
      { command: 'collect', description: 'Собрать у оптовиков (фото)' }, { command: 'sold', description: 'Продано сегодня (фото)' },
      { command: 'returns', description: 'Возвраты' }, { command: 'stock', description: 'Склады Ozon' }, { command: 'new', description: 'Начать заново' },
    ] }).catch(() => undefined);
    res.json({ ok: true, webhook: url, owner: ownerId() ? 'задан' : 'не задан — напишите боту /start, он пришлёт ваш chat id' });
  } catch (err: any) {
    res.status(502).json({ error: 'Не удалось подключить бота', details: String(err?.message ?? err) });
  }
});

/** Отчёт владельцу (утро/вечер) — зовёт крон. */
export async function sendOzonBotReport(kind: 'morning' | 'evening'): Promise<{ sent: boolean; reason?: string }> {
  if (!token() || !ownerId()) return { sent: false, reason: 'not_configured' };
  const text = kind === 'morning' ? await morningReport() : await eveningReport();
  await sendOzonBot(ownerId(), text);
  return { sent: true };
}
