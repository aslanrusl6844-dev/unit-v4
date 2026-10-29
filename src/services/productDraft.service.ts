import { waitUntil } from '@vercel/functions';
import { put } from '@vercel/blob';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { answerCallback, downloadFile, escapeHtml, isAllowedChat, sendMessage, sendPhotos } from '../lib/telegramBot';
import { DEFAULT_AGENT_MODEL, ProductDetails, parsePrices, runDetailsAgent } from './productAgent.service';
import { maybeGenerateShopArticle } from './shopArticle';
import { renderDetailSlides } from './detailSlides.service';

type DraftData = { mode?: 'attach'; result?: ProductDetails; slides?: string[] };
const dataOf = (d: { data: unknown } | null | undefined): DraftData => ((d?.data as DraftData | null) ?? {});

const MAX_REVISIONS = 6;
const MAX_PHOTOS = 10;
const MAX_DETAILS = 10;

const HELP =
  'Новый товар: пришлите 1–5 фото товара по очереди. Цену напишите текстом, например <b>4500 / 6000</b> (цена / старая цена). ' +
  'Когда всё отправили — напишите <b>готово</b>. Отмена — <b>отмена</b>.\n\nДобавить фото в «Детали» существующего товара: <b>детали 1234567</b> (артикул или название), затем фото и «готово».';

export type TgUpdate = {
  update_id?: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string; caption?: string; photo?: Array<{ file_id: string }> };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
};

const money = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₸`);

export function formatDraft(d: ProductDetails, price: number | null, oldPrice: number | null, revision: number): string {
  const lines = [
    `<b>${escapeHtml(d.name)}</b>${revision ? ` (версия ${revision + 1})` : ''}`,
    `Раздел: ${escapeHtml([d.category, d.subcategory, d.type].filter(Boolean).join(' / '))}`,
    `Цена: ${money(price)}${oldPrice ? ` (было ${money(oldPrice)})` : ''}`,
    '',
    escapeHtml(d.description),
  ];
  if (d.composition) lines.push('', `<b>Состав:</b> ${escapeHtml(d.composition)}`);
  if (d.characteristics.length) lines.push('', '<b>Характеристики:</b>', ...d.characteristics.map((c) => `• ${escapeHtml(c.name)}: ${escapeHtml(c.value)}`));
  if (d.features.length) lines.push('', '<b>Для инфографики:</b>', ...d.features.map((x) => `• ${escapeHtml(x)}`));
  if (d.notFound.length) lines.push('', '⚠️ Не нашёл на фото: ' + d.notFound.map(escapeHtml).join('; '));
  if (d.questions.length) lines.push('', '❓ ' + d.questions.map(escapeHtml).join('\n❓ '));
  lines.push('', 'Одобрить или напишите, что исправить.');
  return lines.join('\n');
}

const reviewButtons = (id: string) => [[
  { text: '✅ Одобрить', callback_data: `d:ok:${id}` },
  { text: '✖ Отмена', callback_data: `d:x:${id}` },
]];

async function taxonomyText(): Promise<string> {
  const rows = await prisma.product.findMany({
    where: { category: { not: null } },
    select: { category: true, subcategory: true, type: true },
    distinct: ['category', 'subcategory', 'type'],
    take: 400,
  });
  const by = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = r.category as string;
    if (!by.has(k)) by.set(k, new Set());
    const v = [r.subcategory, r.type].filter(Boolean).join(' → ');
    if (v) by.get(k)!.add(v);
  }
  return [...by.entries()].map(([k, v]) => `${k}: ${[...v].slice(0, 30).join('; ')}`).join('\n');
}


const isAttach = (d: { data: unknown } | null | undefined) => (d?.data as any)?.mode === 'attach';

/** «детали 1234567» / «детали <sku>» / «детали часть названия» → запрос поиска, иначе null. */
export function parseAttachCommand(text: string): string | null {
  const m = /^\s*(?:\/details|детали)\s+(.+)$/i.exec(text.trim());
  return m ? m[1].trim().slice(0, 100) : null;
}

async function startAttach(chatId: string, query: string): Promise<boolean> {
  const exact = await prisma.product.findFirst({
    where: { OR: [{ shopArticle: query }, { sku: query }] },
    select: { id: true, name: true, details: true },
  });
  let target = exact;
  if (!target) {
    const found = await prisma.product.findMany({
      where: { name: { contains: query, mode: 'insensitive' } },
      select: { id: true, name: true, details: true, shopArticle: true },
      take: 6,
    });
    if (!found.length) {
      await sendMessage(chatId, `Не нашёл товар «${escapeHtml(query)}». Укажите артикул (7 цифр) или часть названия: <b>детали 1234567</b>`);
      return false;
    }
    if (found.length > 1) {
      await sendMessage(chatId, 'Нашёл несколько, уточните артикулом:\n' + found.map((p: { name: string; shopArticle: string | null }) => `• ${escapeHtml(p.name)} — ${p.shopArticle ?? 'без артикула'}`).join('\n'));
      return false;
    }
    target = found[0];
  }
  const have = Array.isArray(target.details) ? target.details.length : 0;
  await prisma.productDraft.create({ data: { chatId, productId: target.id, data: { mode: 'attach' } } });
  await sendMessage(
    chatId,
    `Загружаю в «Детали» товара <b>${escapeHtml(target.name)}</b> (сейчас там ${have} из ${MAX_DETAILS}). Присылайте фото по очереди, в конце напишите <b>готово</b>.`,
  );
  return true;
}

async function finishAttach(draftId: string) {
  const claim = await prisma.productDraft.updateMany({ where: { id: draftId, status: 'collecting' }, data: { status: 'details_working' } });
  if (claim.count === 0) return;
  const draft = await prisma.productDraft.findUnique({ where: { id: draftId } });
  if (!draft) return;
  await sendMessage(draft.chatId, `Читаю ${draft.photos.length} фото и рисую слайды «Детали»… (до минуты)`);
  waitUntil(runDetails(draftId, null));
}

async function activeDraft(chatId: string) {
  return prisma.productDraft.findFirst({
    where: { chatId, status: { in: ['collecting', 'details_working', 'details_review'] } },
    orderBy: { createdAt: 'asc' },
  });
}

async function runDetails(draftId: string, feedback: string | null) {
  const draft = await prisma.productDraft.findUnique({ where: { id: draftId } });
  if (!draft) return;
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('нет ANTHROPIC_API_KEY');
    const result = await runDetailsAgent({
      apiKey,
      model: process.env.PRODUCT_AGENT_MODEL || DEFAULT_AGENT_MODEL,
      photos: draft.photos,
      notes: draft.notes,
      price: draft.price,
      oldPrice: draft.oldPrice,
      taxonomy: await taxonomyText(),
      feedback,
      previous: feedback ? (dataOf(draft).result ?? null) : null,
    });
    const first = await fetch(draft.photos[0]).then(async (r) => (r.ok ? { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'image/jpeg' } : null)).catch(() => null);
    const pngs = await renderDetailSlides(result, first?.buf ?? null, first?.mime ?? 'image/jpeg');
    const slides: string[] = [];
    for (let n = 0; n < pngs.length; n++) {
      const b = await put(`details/${draftId}/${Date.now()}-${n + 1}.png`, pngs[n], { access: 'public', contentType: 'image/png', token: env.blobToken });
      slides.push(b.url);
    }
    await prisma.productDraft.update({ where: { id: draftId }, data: { data: { ...dataOf(draft), result, slides } as any, status: 'details_review' } });
    await sendPhotos(draft.chatId, slides);
    await sendMessage(draft.chatId, formatDraft(result, draft.price, draft.oldPrice, draft.revisions), reviewButtons(draftId));
  } catch (err: any) {
    logger.error({ err: String(err?.message ?? err) }, '[ProductAgent] ошибка агента «Детали»');
    await prisma.productDraft.update({ where: { id: draftId }, data: { status: dataOf(draft).result ? 'details_review' : 'collecting' } });
    await sendMessage(draft.chatId, `Не получилось: ${escapeHtml(String(err?.message ?? err)).slice(0, 300)}\nНапишите «готово» ещё раз${dataOf(draft).result ? ' или опишите правку заново' : ''}.`);
  }
}

async function approveDetails(draftId: string) {
  const draft = await prisma.productDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.status !== 'details_review' || !dataOf(draft).result) return;
  const d = dataOf(draft).result as ProductDetails;
  const slides = dataOf(draft).slides ?? [];
  // Атомарно «забираем» черновик — повторный клик не создаст второй товар.
  const claim = await prisma.productDraft.updateMany({ where: { id: draftId, status: 'details_review' }, data: { status: 'done' } });
  if (claim.count === 0) return;
  try {
    if (isAttach(draft) && draft.productId) {
      const target = await prisma.product.findUnique({ where: { id: draft.productId }, select: { name: true, details: true } });
      if (!target) throw new Error('товар не найден');
      const current = Array.isArray(target.details) ? (target.details as string[]) : [];
      const merged = [...current, ...slides].slice(0, MAX_DETAILS);
      await prisma.product.update({ where: { id: draft.productId }, data: { details: merged } });
      await sendMessage(draft.chatId, `Готово: в «Детали» товара <b>${escapeHtml(target.name)}</b> теперь ${merged.length} из ${MAX_DETAILS}${current.length + slides.length > MAX_DETAILS ? ' (часть слайдов не влезла)' : ''}. Откройте товар в приложении и проверьте.`);
      return;
    }
    const article = draft.price != null
      ? await maybeGenerateShopArticle({ currentShopArticle: null, effectivePrice: draft.price, effectiveActive: false })
      : undefined;
    const product = await prisma.product.create({
      data: {
        sku: `tg-${draft.id}`,
        name: d.name,
        category: d.category,
        subcategory: d.subcategory ?? null,
        type: d.type,
        description: d.description,
        composition: d.composition ?? null,
        characteristics: d.characteristics.length ? JSON.stringify(d.characteristics) : null,
        images: JSON.stringify(draft.photos),
        details: slides,
        shopPrice: draft.price ?? null,
        shopOldPrice: draft.oldPrice ?? null,
        shopActive: false, // в продажу включает владелец сам
        ...(article ? { shopArticle: article } : {}),
      },
    });
    await prisma.productDraft.update({ where: { id: draftId }, data: { productId: product.id } });
    await sendMessage(
      draft.chatId,
      `Сохранил: <b>${escapeHtml(d.name)}</b>${article ? ` (артикул ${article})` : ''}. Товар пока <b>не в продаже</b> — включите его в админке «My Market» после проверки. Инфографику подключим следующим этапом.\n\nМожно присылать следующий товар.`,
    );
  } catch (err: any) {
    logger.error({ err: String(err?.message ?? err) }, '[ProductAgent] не удалось создать товар');
    await prisma.productDraft.update({ where: { id: draftId }, data: { status: 'details_review' } });
    await sendMessage(draft.chatId, `Не удалось сохранить товар: ${escapeHtml(String(err?.message ?? err)).slice(0, 300)}`);
  }
}

async function addPhoto(chatId: string, fileId: string, caption: string | undefined) {
  let draft = await activeDraft(chatId);
  const cmd = caption ? parseAttachCommand(caption) : null;
  if (cmd && !draft) {
    if (!(await startAttach(chatId, cmd))) return;
    draft = await activeDraft(chatId);
    caption = undefined;
  }
  if (draft && draft.status !== 'collecting') {
    await sendMessage(chatId, 'Сначала завершите текущий товар: одобрите, напишите правки или «отмена».');
    return;
  }
  const isNew = !draft;
  if (!draft) {
    const created = await prisma.productDraft.create({ data: { chatId } });
    const oldest = await prisma.productDraft.findFirst({ where: { chatId, status: 'collecting' }, orderBy: { createdAt: 'asc' } });
    if (oldest && oldest.id !== created.id) {
      await prisma.productDraft.delete({ where: { id: created.id } }).catch(() => undefined);
      draft = oldest;
    } else {
      draft = created;
    }
  }
  if (draft.photos.length >= MAX_PHOTOS) {
    await sendMessage(chatId, `Максимум ${MAX_PHOTOS} фото на товар. Напишите «готово».`);
    return;
  }
  const file = await downloadFile(fileId);
  const blob = await put(`tg/${draft.id}/${Date.now()}.jpg`, file.buffer, { access: 'public', contentType: file.contentType, token: env.blobToken });
  const attach = isAttach(draft);
  const prices = caption && !attach ? parsePrices(caption) : {};
  await prisma.productDraft.update({
    where: { id: draft.id },
    data: {
      photos: { push: blob.url },
      ...(prices.price ? { price: prices.price, oldPrice: prices.oldPrice ?? null } : {}),
      ...(caption && !attach && !prices.price ? { notes: [draft.notes, caption].filter(Boolean).join('\n') } : {}),
    },
  });
  if (isNew && !attach) await sendMessage(chatId, 'Принял фото. ' + HELP);
}

async function handleText(chatId: string, text: string) {
  const t = text.trim();
  const low = t.toLowerCase();
  const draft = await activeDraft(chatId);

  if (low === '/start' || low === '/help') return sendMessage(chatId, HELP);
  if (['отмена', '/cancel', 'cancel'].includes(low)) {
    if (draft) await prisma.productDraft.update({ where: { id: draft.id }, data: { status: 'cancelled' } });
    return sendMessage(chatId, draft ? 'Отменил. Можно начинать новый товар.' : 'Нечего отменять.');
  }
  const cmd = parseAttachCommand(t);
  if (cmd) {
    if (draft) return sendMessage(chatId, 'Сначала завершите текущее: «готово» или «отмена».');
    await startAttach(chatId, cmd);
    return;
  }
  if (!draft) return sendMessage(chatId, HELP);

  if (draft.status === 'collecting' && isAttach(draft)) {
    if (['готово', '/done', 'done', 'все', 'всё'].includes(low)) {
      if (!draft.photos.length) return sendMessage(chatId, 'Фото ещё нет. Пришлите хотя бы одно.');
      return finishAttach(draft.id);
    }
    return sendMessage(chatId, 'Жду фото для «Деталей». Когда всё отправили — «готово», отмена — «отмена».');
  }

  if (draft.status === 'collecting') {
    if (['готово', '/done', 'done', 'все', 'всё'].includes(low)) {
      if (!draft.photos.length) return sendMessage(chatId, 'Фото ещё нет. Пришлите хотя бы одно.');
      const claim = await prisma.productDraft.updateMany({ where: { id: draft.id, status: 'collecting' }, data: { status: 'details_working' } });
      if (claim.count === 0) return;
      await sendMessage(chatId, `Читаю ${draft.photos.length} фото${draft.price ? '' : ' (цены нет — напишите её потом, я пока подготовлю карточку)'}…`);
      waitUntil(runDetails(draft.id, null));
      return;
    }
    const prices = parsePrices(t);
    if (prices.price && t.length <= 40) {
      await prisma.productDraft.update({ where: { id: draft.id }, data: { price: prices.price, oldPrice: prices.oldPrice ?? null } });
      return sendMessage(chatId, `Цена: ${money(prices.price)}${prices.oldPrice ? ` (было ${money(prices.oldPrice)})` : ''}. Ещё фото или «готово».`);
    }
    await prisma.productDraft.update({ where: { id: draft.id }, data: { notes: [draft.notes, t].filter(Boolean).join('\n') } });
    return sendMessage(chatId, 'Записал примечание. Ещё фото или «готово».');
  }

  if (draft.status === 'details_working') return sendMessage(chatId, 'Ещё работаю над карточкой, минутку…');

  if (draft.status === 'details_review') {
    if (draft.revisions >= MAX_REVISIONS) return sendMessage(chatId, 'Слишком много правок подряд. Одобрите текущий вариант или «отмена».', reviewButtons(draft.id));
    const prices = parsePrices(t);
    const onlyPrice = prices.price && t.length <= 40;
    if (onlyPrice) {
      await prisma.productDraft.update({ where: { id: draft.id }, data: { price: prices.price, oldPrice: prices.oldPrice ?? null } });
      return sendMessage(chatId, `Цена обновлена: ${money(prices.price)}${prices.oldPrice ? ` (было ${money(prices.oldPrice)})` : ''}.`, reviewButtons(draft.id));
    }
    const claim = await prisma.productDraft.updateMany({
      where: { id: draft.id, status: 'details_review' },
      data: { status: 'details_working', revisions: { increment: 1 } },
    });
    if (claim.count === 0) return;
    await sendMessage(chatId, 'Понял, переделываю…');
    waitUntil(runDetails(draft.id, t));
  }
}

async function handleCallback(cb: NonNullable<TgUpdate['callback_query']>) {
  const chatId = cb.message?.chat.id;
  if (!chatId || !isAllowedChat(chatId)) return;
  const [, action, id] = (cb.data ?? '').split(':');
  await answerCallback(cb.id);
  if (!id) return;
  if (action === 'ok') return approveDetails(id);
  if (action === 'x') {
    await prisma.productDraft.updateMany({ where: { id, status: { in: ['collecting', 'details_review'] } }, data: { status: 'cancelled' } });
    await sendMessage(String(chatId), 'Отменил. Можно начинать новый товар.');
  }
}

/** Точка входа вебхука. Чужие чаты игнорируются молча. */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    const m = update.message;
    if (!m || !isAllowedChat(m.chat.id)) return;
    const chatId = String(m.chat.id);
    if (m.photo?.length) return await addPhoto(chatId, m.photo[m.photo.length - 1].file_id, m.caption);
    if (m.text) return await handleText(chatId, m.text);
  } catch (err: any) {
    logger.error({ err: String(err?.message ?? err) }, '[ProductAgent] ошибка обработки апдейта');
    const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chat && isAllowedChat(chat)) await sendMessage(String(chat), 'Что-то пошло не так, попробуйте ещё раз.').catch(() => undefined);
  }
}
