import { Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { waitUntil } from '@vercel/functions';
import { prisma } from '../db/prisma';
import { buildQtyCard } from '../services/photoCollage';
import { logger } from '../utils/logger';
import {
  askOzonManager, daySales, eveningReport, fbsToShip, fboStock, morningReport, photoCards, purchaseNeeds, returnsList,
  setOzonBotPhotoSender, setOzonBotPickHandlers, photosByOffer, type PhotoCard,
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
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  form.append('photo', img, 'item.jpg');
  const r = await tgFetch(`https://api.telegram.org/bot${token()}/sendPhoto`, { method: 'POST', body: form } as any);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) throw new Error(`telegram sendPhoto: ${data?.description ?? r.status}`);
}

// ---------------------------------------------------------------- список сборки с номерами

type PickItem = { n: number; name: string; qty: number; postings: string[]; done: boolean; offerId?: string; photo?: string | null; stickers?: string[] };

async function savePickList(chatId: string, title: string, cards: PhotoCard[]): Promise<void> {
  const items: PickItem[] = cards.map((c, i) => ({ n: i + 1, name: c.name, qty: c.qty, postings: c.postings ?? [], done: false, offerId: c.offerId, photo: c.photo, stickers: c.stickers ?? [] }));
  await prisma.ozonBotPickList.upsert({
    where: { chatId }, create: { chatId, title, items: JSON.stringify(items) }, update: { title, items: JSON.stringify(items) },
  });
}

async function loadPickList(chatId: string): Promise<{ title: string; items: PickItem[] } | null> {
  const row = await prisma.ozonBotPickList.findUnique({ where: { chatId } });
  if (!row) return null;
  try { return { title: row.title, items: JSON.parse(row.items) as PickItem[] }; } catch { return null; }
}

/** «1 3 5», «1,2», «4-7», «есть 2 и 6» → номера. */
export function parsePickNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d{1,3})\s*[-–—]\s*(\d{1,3})|(\d{1,3})/g)) {
    if (m[1] && m[2]) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b) && i - Math.min(a, b) < 200; i++) out.add(i); }
    else if (m[3]) out.add(+m[3]);
  }
  return [...out];
}

/** Сообщение — это номера собранного? Только цифры/диапазоны, можно со словами «есть / собрал / готово / убери». */
export function looksLikePickNumbers(text: string): boolean {
  const t = text.toLowerCase().replace(/^(есть|собрал[аи]?|собрано|готово|убери|убрать|вычеркни|ок|ok|done)[\s:,-]*/u, '').trim();
  return /\d/.test(t) && /^[\d\s,.;+–—-]*(и[\s\d,.;+–—-]*)*$/u.test(t);
}

/** Отметить номера собранными (или вернуть — undo) и показать, что осталось. */
export async function markPicked(chatId: string, nums: number[], undo = false): Promise<string> {
  const list = await loadPickList(chatId);
  if (!list || !list.items.length) return 'Списка сборки нет. Сначала попросите «фото, что отгрузить» или /ship_photo.';
  const max = list.items.length;
  const ok = nums.filter((n) => n >= 1 && n <= max);
  const bad = nums.filter((n) => n < 1 || n > max);
  for (const it of list.items) if (ok.includes(it.n)) it.done = !undo;
  await prisma.ozonBotPickList.update({ where: { chatId }, data: { items: JSON.stringify(list.items) } });
  return pickListText(list.title, list.items, undo ? `↩️ Вернул в список: ${ok.join(', ')}` : ok.length ? `✅ Собрано: ${ok.join(', ')}` : '', bad.length ? `Таких номеров нет: ${bad.join(', ')} (в списке 1–${max})` : '');
}

function pickListText(title: string, items: PickItem[], head = '', warn = ''): string {
  const left = items.filter((i) => !i.done);
  const lines = [head, warn].filter(Boolean);
  if (!left.length) return [...lines, `🎉 <b>Всё собрано!</b> ${items.length} из ${items.length}.`].join('\n');
  lines.push(`<b>Осталось собрать: ${left.length} из ${items.length}</b> (${left.reduce((s, i) => s + i.qty, 0)} шт)`);
  for (const i of left) lines.push(`<b>${i.n}.</b> ${escH(i.name.slice(0, 60))} — <b>${i.qty} шт</b>${i.postings.length ? `\n     ${i.postings.map(escH).join(', ')}` : ''}`);
  lines.push('', 'Пришлите номера собранного, например: <b>2 5 7</b> или <b>3-6</b>. Вернуть: «верни 4».');
  return lines.join('\n').slice(0, 4000);
}

/** Фото ещё не собранных — с теми же номерами, что в первом списке. */
export async function pickListLeftPhotos(chatId: string): Promise<string> {
  const list = await loadPickList(chatId);
  if (!list || !list.items.length) return 'Списка сборки нет. Сначала попросите «фото, что отгрузить» или /ship_photo.';
  const left = list.items.filter((i) => !i.done);
  if (!left.length) return `🎉 Всё собрано! ${list.items.length} из ${list.items.length}.`;
  // Список, сохранённый старой версией, без фото: находим товар по номерам заказов в Ozon и берём его фото.
  const noPhoto = left.filter((i) => !i.photo);
  if (noPhoto.length) {
    const offerOf = new Map<string, string>();
    try {
      const ship = await fbsToShip();
      const byPosting = new Map(ship.postings.map((p) => [p.postingNumber, p.items]));
      for (const i of noPhoto) {
        if (i.offerId) { offerOf.set(String(i.n), i.offerId); continue; }
        for (const pn of i.postings) {
          const hit = byPosting.get(pn)?.find((x) => x.name === i.name) ?? (byPosting.get(pn)?.length === 1 ? byPosting.get(pn)![0] : undefined);
          if (hit) { offerOf.set(String(i.n), hit.offerId); break; }
        }
      }
      const photos = await photosByOffer([...offerOf.values()]);
      for (const i of noPhoto) {
        const off = offerOf.get(String(i.n));
        if (off) { i.offerId = off; i.photo = photos.get(off) ?? null; }
      }
      if (noPhoto.some((i) => i.photo)) await prisma.ozonBotPickList.update({ where: { chatId }, data: { items: JSON.stringify(list.items) } });
    } catch (err: any) {
      logger.warn({ err: String(err?.message ?? err) }, '[OzonBot] фото для старого списка не нашлись');
    }
  }
  const cards: PhotoCard[] = left.map((i) => ({ offerId: i.offerId ?? '', name: i.name, qty: i.qty, photo: i.photo ?? null, stickers: i.stickers ?? [], postings: i.postings }));
  await sendPhotoCards(chatId, `⏳ Ещё не собрано (${list.title.replace(/^\S+\s*/, '')})`, cards, true, left.map((i) => i.n));
  return `Отправил фото ещё не собранных: ${left.length} из ${list.items.length}. Пришлите номера собранного.`;
}

export async function pickListLeft(chatId: string): Promise<string> {
  const list = await loadPickList(chatId);
  if (!list || !list.items.length) return 'Списка сборки нет. Сначала попросите «фото, что отгрузить» или /ship_photo.';
  return pickListText(list.title, list.items);
}

export async function sendPhotoCards(chatId: string, title: string, cards: PhotoCard[], numbered = false, nums?: number[]): Promise<void> {
  const numOf = (i: number) => nums?.[i] ?? i + 1;
  const started = Date.now();
  const total = cards.reduce((s, c) => s + c.qty, 0);
  if (!cards.length) { await sendOzonBot(chatId, `${title}\nПока ничего нет 👍`); return; }
  const list = cards.slice(0, 36);
  // Фото качаем сами, по 6 параллельно (Telegram не всегда забирает картинку с CDN Ozon).
  const images: (Buffer | null)[] = new Array(list.length).fill(null);
  for (let i = 0; i < list.length && Date.now() - started < 25_000; i += 6) {
    const got = await Promise.all(list.slice(i, i + 6).map((c) => (c.photo ? loadImage(c.photo) : Promise.resolve(null))));
    for (let j = 0; j < got.length; j++) images[i + j] = got[j] ? Buffer.from(await got[j]!.arrayBuffer()) : null;
  }
  // Столбиком: одно сообщение = одна узкая картинка (фото ≈1/3 ширины + крупно «N шт»), без подписей.
  await sendOzonBot(chatId, `<b>${escH(title)}</b>: ${cards.length} товаров, ${total} шт`);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (Date.now() - started > 50_000) {
      await sendOzonBot(chatId, ['<b>Не успел отправить фото:</b>', ...list.slice(i).map((x) => `• <b>${x.qty} шт</b> — ${escH(x.name.slice(0, 80))}`)].join('\n'));
      break;
    }
    try {
      const jpeg = await buildQtyCard(images[i], c.qty, images[i] ? '' : c.name, c.stickers ?? [], numbered ? numOf(i) : undefined);
      // Для отгрузки — под фото номера заказов Ozon; в списке сборки — номер позиции.
      const num = numbered ? `<b>${numOf(i)}.</b> ` : '';
      const caption = c.postings?.length
        ? `${num}<b>${c.qty} шт</b> · ${escH(c.name.slice(0, 60))}\n${c.postings.map((p) => `№ ${escH(p)}`).join('\n')}`.slice(0, 1000)
        : numbered ? `${num}${escH(c.name.slice(0, 60))} — <b>${c.qty} шт</b>` : '';
      await sendPhotoFile(chatId, new Blob([jpeg], { type: 'image/jpeg' }), caption);
    } catch (err: any) {
      logger.warn({ err: String(err?.message ?? err) }, '[OzonBot] карточка не отправилась');
      await sendOzonBot(chatId, `${numbered ? `<b>${numOf(i)}.</b> ` : ''}<b>${c.qty} шт</b> — ${escH(c.name.slice(0, 80))}${c.postings?.length ? '\n' + c.postings.map((p) => `№ ${escH(p)}`).join('\n') : ''}`).catch(() => undefined);
    }
  }
  if (cards.length > list.length) {
    await sendOzonBot(chatId, ['<b>Ещё товары:</b>', ...cards.slice(list.length).map((c, k) => `${numbered ? `<b>${numOf(list.length + k)}.</b>` : '•'} <b>${c.qty} шт</b> — ${escH(c.name.slice(0, 80))}`)].join('\n'));
  }
  if (numbered && !nums) {
    await savePickList(chatId, title, cards);
    await sendOzonBot(chatId, 'Собрали позицию — пришлите её номер (можно несколько: <b>1 3 5</b> или <b>2-6</b>), я вычеркну и покажу, что осталось. /left — что осталось.');
  }
}
setOzonBotPhotoSender((chatId, title, cards, numbered) => sendPhotoCards(chatId, title, cards, numbered));
setOzonBotPickHandlers({ mark: markPicked, left: pickListLeft, leftPhotos: pickListLeftPhotos });

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
  '/ship_photo — готовые к отгрузке (накладные сделаны): фото с номерами 1, 2, 3…, количество и номера заказов',
  'Собрали — пришлите номера (1 3 5 или 2-6), бот вычеркнет; /left — что осталось, /left_photo — фото несобранного',
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
    if (cmd === '/collect' || cmd === '/sold' || cmd === '/ship_photo') {
      const kind = cmd === '/sold' ? 'sold' : cmd === '/ship_photo' ? 'ship' : 'collect';
      const { title, cards } = await photoCards(kind);
      await sendPhotoCards(chatId, title, cards, kind !== 'sold');
      return;
    }
    if (cmd === '/left') { await sendOzonBot(chatId, await pickListLeft(chatId)); return; }
    if (cmd === '/left_photo') { await sendOzonBot(chatId, await pickListLeftPhotos(chatId)); return; }
    // «фото тех, что ещё не собрал» — сразу, без ИИ.
    if (!photo?.length && /фот/i.test(text) && /(не\s*собра|осталь|остав)/i.test(text) && (await loadPickList(chatId))?.items.length) {
      await sendOzonBot(chatId, await pickListLeftPhotos(chatId));
      return;
    }
    // Номера собранного: «1 3 5», «2-6», «есть 4» — вычёркиваем без ИИ. «верни 4» — назад в список.
    if (!photo?.length && /^(верни|вернуть|отмени)\s/i.test(text) && /\d/.test(text)) { await sendOzonBot(chatId, await markPicked(chatId, parsePickNumbers(text), true)); return; }
    if (!photo?.length && looksLikePickNumbers(text) && (await loadPickList(chatId))?.items.length) {
      await sendOzonBot(chatId, await markPicked(chatId, parsePickNumbers(text)));
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
      { command: 'ship', description: 'Что отгрузить' }, { command: 'ship_photo', description: 'Готовы к отгрузке: фото и номера' }, { command: 'left', description: 'Что осталось собрать' }, { command: 'left_photo', description: 'Фото несобранного' }, { command: 'buy', description: 'Закупка под заказы' },
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
