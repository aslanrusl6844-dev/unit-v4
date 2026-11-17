"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDraft = formatDraft;
exports.parseAttachCommand = parseAttachCommand;
exports.inferIntent = inferIntent;
exports.parseSliceCommand = parseSliceCommand;
exports.parseRawCommand = parseRawCommand;
exports.setSelfBaseUrl = setSelfBaseUrl;
exports.handleSceneJob = handleSceneJob;
exports.handleUpdate = handleUpdate;
const support_service_1 = require("./support.service");
const functions_1 = require("@vercel/functions");
const blob_1 = require("@vercel/blob");
const prisma_1 = require("../db/prisma");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const telegramBot_1 = require("../lib/telegramBot");
const productAgent_service_1 = require("./productAgent.service");
const shopArticle_1 = require("./shopArticle");
const detailSlides_service_1 = require("./detailSlides.service");
const geminiImage_service_1 = require("./geminiImage.service");
const sheetSplit_service_1 = require("./sheetSplit.service");
const dataOf = (d) => (d?.data ?? {});
const MAX_REVISIONS = 6;
const MAX_PHOTOS = 10;
const MAX_DETAILS = 10;
const HELP = 'Новый товар: пришлите 1–5 фото товара по очереди. Цену напишите текстом, например <b>4500 / 6000</b> (цена / старая цена). ' +
    'Когда всё отправили — напишите <b>готово</b>. Отмена — <b>отмена</b>.\n\nКрасивые «Детали» делает бот: <b>детали 1234567</b> (артикул или название), затем фото и «готово». Проще всего: отправьте артикул (7 цифр), потом картинки файлом — бот спросит, что с ними сделать. Или командами: один лист с 10 слайдами нарезать и положить в «Детали»: <b>нарезать 1234567</b>, затем лист файлом. Свои готовые картинки (например из ChatGPT) положить в «Детали» как есть: <b>картинки 1234567</b>, затем картинки и «готово».';
const money = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₸`);
function formatDraft(d, price, oldPrice, revision) {
    const lines = [
        `<b>${(0, telegramBot_1.escapeHtml)(d.name)}</b>${revision ? ` (версия ${revision + 1})` : ''}`,
        `Раздел: ${(0, telegramBot_1.escapeHtml)([d.category, d.subcategory, d.type].filter(Boolean).join(' / '))}`,
        `Цена: ${money(price)}${oldPrice ? ` (было ${money(oldPrice)})` : ''}`,
        '',
        (0, telegramBot_1.escapeHtml)(d.description),
    ];
    if (d.composition)
        lines.push('', `<b>Состав:</b> ${(0, telegramBot_1.escapeHtml)(d.composition)}`);
    if (d.characteristics.length)
        lines.push('', '<b>Характеристики:</b>', ...d.characteristics.map((c) => `• ${(0, telegramBot_1.escapeHtml)(c.name)}: ${(0, telegramBot_1.escapeHtml)(c.value)}`));
    if (d.features.length)
        lines.push('', '<b>Для инфографики:</b>', ...d.features.map((x) => `• ${(0, telegramBot_1.escapeHtml)(x)}`));
    if (d.notFound.length)
        lines.push('', '⚠️ Не нашёл на фото: ' + d.notFound.map(telegramBot_1.escapeHtml).join('; '));
    if (d.questions.length)
        lines.push('', '❓ ' + d.questions.map(telegramBot_1.escapeHtml).join('\n❓ '));
    lines.push('', 'Одобрить или напишите, что исправить.');
    return lines.join('\n');
}
const reviewButtons = (id) => [[
        { text: '✅ Одобрить', callback_data: `d:ok:${id}` },
        { text: '✖ Отмена', callback_data: `d:x:${id}` },
    ]];
async function taxonomyText() {
    const rows = await prisma_1.prisma.product.findMany({
        where: { category: { not: null } },
        select: { category: true, subcategory: true, type: true },
        distinct: ['category', 'subcategory', 'type'],
        take: 400,
    });
    const by = new Map();
    for (const r of rows) {
        const k = r.category;
        if (!by.has(k))
            by.set(k, new Set());
        const v = [r.subcategory, r.type].filter(Boolean).join(' → ');
        if (v)
            by.get(k).add(v);
    }
    return [...by.entries()].map(([k, v]) => `${k}: ${[...v].slice(0, 30).join('; ')}`).join('\n');
}
const isAttach = (d) => d?.data?.mode === 'attach';
/** «детали 1234567» / «детали <sku>» / «детали часть названия» → запрос поиска, иначе null. */
function parseAttachCommand(text) {
    const m = /^\s*(?:\/details|детали)\s+(.+)$/i.exec(text.trim());
    return m ? m[1].trim().slice(0, 100) : null;
}
/**
 * Понимает обычную речь: «из этой картинки разъедини все фото на формат 1:1 и загрузи в детали по артикулу 2728897».
 * Артикул — отдельное 7-значное число. Режим: нарезка / как есть / спросить кнопками.
 */
function inferIntent(text) {
    const a = /(?<!\d)(\d{7})(?!\d)/.exec(text);
    const article = a?.[1];
    if (!article)
        return null;
    const gm = /(\d{1,2})\s*(?:x|х|×)\s*(\d{1,2})/i.exec(text);
    const grid = gm ? (0, sheetSplit_service_1.parseGrid)(`${gm[1]}x${gm[2]}`) ?? undefined : undefined;
    const slice = /нареж|разъедин|разрез|вырез|раздел|по одному|отдельн|слайд|1\s*[:x×]\s*1|один к одному/i.test(text);
    const raw = /как есть|без обработки|не обрабатыва/i.test(text);
    return { article, mode: slice ? 'slice' : raw ? 'raw' : 'ask', grid };
}
/** «нарезать 1234567 [2x5]» — один лист с несколькими слайдами режем на отдельные картинки. */
function parseSliceCommand(text) {
    const m = /^\s*(?:нарезать|\/slice|лист)\s+(.+)$/i.exec(text.trim());
    if (!m)
        return null;
    let rest = m[1].trim();
    let grid;
    const g = /\s+(\d{1,2}\s*(?:x|х|×)\s*\d{1,2})$/i.exec(rest);
    if (g) {
        grid = (0, sheetSplit_service_1.parseGrid)(g[1]) ?? undefined;
        rest = rest.slice(0, g.index).trim();
    }
    return rest ? { query: rest.slice(0, 100), grid } : null;
}
/** «картинки 1234567» — готовые картинки (например, из вашего ChatGPT) кладём в «Детали» как есть. */
function parseRawCommand(text) {
    const m = /^\s*(?:\/images|картинки|готовые)\s+(.+)$/i.exec(text.trim());
    return m ? m[1].trim().slice(0, 100) : null;
}
/** Находит товар по артикулу/sku/названию. Если не нашёл или несколько — сам пишет в чат и возвращает null. */
async function resolveTarget(chatId, query) {
    const exact = await prisma_1.prisma.product.findFirst({
        where: { OR: [{ shopArticle: query }, { sku: query }] },
        select: { id: true, name: true, details: true },
    });
    if (exact)
        return exact;
    const found = await prisma_1.prisma.product.findMany({
        where: { name: { contains: query, mode: 'insensitive' } },
        select: { id: true, name: true, details: true, shopArticle: true },
        take: 6,
    });
    if (!found.length) {
        await (0, telegramBot_1.sendMessage)(chatId, `Не нашёл товар «${(0, telegramBot_1.escapeHtml)(query)}». Укажите артикул (7 цифр) или часть названия.`);
        return null;
    }
    if (found.length > 1) {
        await (0, telegramBot_1.sendMessage)(chatId, 'Нашёл несколько, уточните артикулом:\n' + found.map((p) => `• ${(0, telegramBot_1.escapeHtml)(p.name)} — ${p.shopArticle ?? 'без артикула'}`).join('\n'));
        return null;
    }
    return found[0];
}
/** Лист уже загружен и ждёт артикул: привязываем к товару и сразу режем. */
async function bindSheetToProduct(draftId, chatId, query, grid) {
    const target = await resolveTarget(chatId, query);
    if (!target)
        return;
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft?.photos[0])
        return;
    await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { productId: target.id, data: { mode: 'slice', ...(grid ? { grid } : {}) } } });
    const buf = Buffer.from(await (await fetch(draft.photos[0])).arrayBuffer());
    await (0, telegramBot_1.sendMessage)(chatId, `Товар: <b>${(0, telegramBot_1.escapeHtml)(target.name)}</b>. Режу лист…`);
    await reviewSlices(draftId, buf, grid);
}
async function startAttach(chatId, query, raw = false, slice, ask = false) {
    const exact = await prisma_1.prisma.product.findFirst({
        where: { OR: [{ shopArticle: query }, { sku: query }] },
        select: { id: true, name: true, details: true },
    });
    let target = exact;
    if (!target) {
        const found = await prisma_1.prisma.product.findMany({
            where: { name: { contains: query, mode: 'insensitive' } },
            select: { id: true, name: true, details: true, shopArticle: true },
            take: 6,
        });
        if (!found.length) {
            await (0, telegramBot_1.sendMessage)(chatId, `Не нашёл товар «${(0, telegramBot_1.escapeHtml)(query)}». Укажите артикул (7 цифр) или часть названия: <b>детали 1234567</b>`);
            return false;
        }
        if (found.length > 1) {
            await (0, telegramBot_1.sendMessage)(chatId, 'Нашёл несколько, уточните артикулом:\n' + found.map((p) => `• ${(0, telegramBot_1.escapeHtml)(p.name)} — ${p.shopArticle ?? 'без артикула'}`).join('\n'));
            return false;
        }
        target = found[0];
    }
    const have = Array.isArray(target.details) ? target.details.length : 0;
    await prisma_1.prisma.productDraft.create({ data: { chatId, productId: target.id, data: ask ? { mode: 'ask' } : slice ? { mode: 'slice', ...(slice.grid ? { grid: slice.grid } : {}) } : raw ? { mode: 'attach', raw: true } : { mode: 'attach' } } });
    await (0, telegramBot_1.sendMessage)(chatId, ask ? `Товар: <b>${(0, telegramBot_1.escapeHtml)(target.name)}</b> (в «Деталях» сейчас ${have} из ${MAX_DETAILS}). Пришлите картинку или картинки <b>файлом</b>, и я спрошу, что с ними сделать.` :
        slice ? `Режу лист для «Деталей» товара <b>${(0, telegramBot_1.escapeHtml)(target.name)}</b> (сейчас там ${have} из ${MAX_DETAILS}). Пришлите лист с картинками <b>файлом</b> (скрепка → Файл), чтобы Telegram не сжал качество. Если знаете сетку, напишите её: <b>2x5</b> (строк × столбцов).` :
            raw ? `Готовые картинки пойдут в «Детали» товара <b>${(0, telegramBot_1.escapeHtml)(target.name)}</b> как есть, без обработки (сейчас там ${have} из ${MAX_DETAILS}). Присылайте картинки по очереди <b>как фото или файлом</b>, в конце напишите <b>готово</b>.` :
                `Загружаю в «Детали» товара <b>${(0, telegramBot_1.escapeHtml)(target.name)}</b> (сейчас там ${have} из ${MAX_DETAILS}). Присылайте фото по очереди, в конце напишите <b>готово</b>.`);
    return true;
}
async function finishRaw(draftId) {
    const claim = await prisma_1.prisma.productDraft.updateMany({ where: { id: draftId, status: 'collecting' }, data: { status: 'done' } });
    if (claim.count === 0)
        return;
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft?.productId)
        return;
    const product = await prisma_1.prisma.product.findUnique({ where: { id: draft.productId }, select: { name: true, details: true } });
    if (!product)
        return void (await (0, telegramBot_1.sendMessage)(draft.chatId, 'Товар не найден (удалён?).'));
    const current = Array.isArray(product.details) ? product.details : [];
    const merged = [...current, ...draft.photos.filter((u) => !current.includes(u))].slice(0, MAX_DETAILS);
    await prisma_1.prisma.product.update({ where: { id: draft.productId }, data: { details: merged } });
    await (0, telegramBot_1.sendMessage)(draft.chatId, `Готово: в «Детали» товара <b>${(0, telegramBot_1.escapeHtml)(product.name)}</b> теперь ${merged.length} из ${MAX_DETAILS}${current.length + draft.photos.length > MAX_DETAILS ? ' (часть не влезла)' : ''}. Проверьте в приложении.`);
}
async function finishAttach(draftId) {
    const claim = await prisma_1.prisma.productDraft.updateMany({ where: { id: draftId, status: 'collecting' }, data: { status: 'details_working' } });
    if (claim.count === 0)
        return;
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft)
        return;
    await (0, telegramBot_1.sendMessage)(draft.chatId, `Читаю ${draft.photos.length} фото и рисую слайды «Детали»… (до минуты)`);
    (0, functions_1.waitUntil)(runDetails(draftId, null));
}
/** Новая команда отменяет застрявший прошлый черновик (кроме того, что прямо сейчас рисуется). true — можно продолжать. */
async function supersede(chatId, draft) {
    if (!draft)
        return true;
    if (draft.status === 'details_working' || draft.status === 'details_rendering') {
        await (0, telegramBot_1.sendMessage)(chatId, 'Ещё идёт работа над предыдущим товаром. Подождите минуту или напишите «отмена».');
        return false;
    }
    await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { status: 'cancelled' } });
    await (0, telegramBot_1.sendMessage)(chatId, 'Прошлый незавершённый черновик отменил, начинаю новый.');
    return true;
}
async function activeDraft(chatId) {
    return prisma_1.prisma.productDraft.findFirst({
        where: { chatId, status: { in: ['collecting', 'details_working', 'details_rendering', 'details_review', 'slice_review'] } },
        orderBy: { createdAt: 'asc' },
    });
}
let selfBaseUrl = '';
/** Адрес этого же сервера — по нему разносим генерацию сцен на отдельные вызовы (у каждого свои 60 с). */
function setSelfBaseUrl(url) { if (url)
    selfBaseUrl = url; }
const MAX_SCENES = 6;
const SCENE_FALLBACKS = [
    { headline: 'Главное в деталях', caption: 'Качество, которое видно сразу', prompt: 'bright minimalist studio with soft daylight, pastel gradient backdrop, subtle props related to the product category, elegant composition' },
    { headline: 'Крупным планом', caption: 'Упаковка и важные детали', prompt: 'close-up macro view of the product, shallow depth of field, soft natural light, clean neutral surface' },
    { headline: 'Для каждого дня', caption: 'Удобно и практично', prompt: 'cozy lifestyle scene in a warm home interior where this kind of product is used, natural window light, product in the foreground' },
    { headline: 'Со всех сторон', caption: 'Смотрите, что внутри набора', prompt: 'product shown from a different angle (three-quarter view) on a colored seamless background with a soft shadow' },
];
const planOf = (d) => d.data?.plan ?? [];
async function loadPhotos(urls, limit = 4) {
    const got = await Promise.all(urls.slice(0, limit).map((u) => fetch(u).then(async (r) => (r.ok ? await (async () => { const data = Buffer.from(await r.arrayBuffer()); return { data, mime: (0, geminiImage_service_1.sniffImageMime)(data) }; })() : null)).catch(() => null)));
    return got.filter(Boolean);
}
async function runDetails(draftId, feedback) {
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft)
        return;
    try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error('нет ANTHROPIC_API_KEY');
        const result = await (0, productAgent_service_1.runDetailsAgent)({
            apiKey,
            model: process.env.PRODUCT_AGENT_MODEL || productAgent_service_1.DEFAULT_AGENT_MODEL,
            photos: draft.photos,
            notes: draft.notes,
            price: draft.price,
            oldPrice: draft.oldPrice,
            taxonomy: await taxonomyText(),
            feedback,
            previous: feedback ? (dataOf(draft).result ?? null) : null,
        });
        const plan = [...result.scenes];
        for (const f of SCENE_FALLBACKS)
            if (plan.length < 4)
                plan.push(f);
        plan.splice(MAX_SCENES);
        await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { data: { ...dataOf(draft), result, plan, runId: Date.now() }, status: 'details_working' } });
        const hasImageKey = !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
        if (!hasImageKey || !selfBaseUrl) {
            await (0, telegramBot_1.sendMessage)(draft.chatId, !hasImageKey ? '⚠️ Нет ключа GEMINI_API_KEY / OPENAI_API_KEY на сервере — делаю простые слайды без красивых фонов.' : '⚠️ Не знаю адрес сервера — делаю простые слайды без красивых фонов.');
            return await finalizeSlides(draftId, true);
        }
        await (0, telegramBot_1.sendMessage)(draft.chatId, `Карточка готова, рисую ${plan.length} картинок-сцен (около минуты)…`);
        // Каждая сцена — отдельный вызов сервера со своим лимитом времени. Дочерний вызов отвечает сразу.
        const results = await Promise.all(plan.map((_, index) => fetch(`${selfBaseUrl}/api/telegram-agent/scene`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': (0, telegramBot_1.webhookSecret)() },
            body: JSON.stringify({ draftId, index }),
            signal: AbortSignal.timeout(15_000),
        }).then((r) => r.ok).catch(() => false)));
        if (results.every((ok) => !ok)) {
            await (0, telegramBot_1.sendMessage)(draft.chatId, '⚠️ Не удалось запустить рисование сцен — делаю простые слайды.');
            await finalizeSlides(draftId, true);
        }
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[ProductAgent] ошибка агента «Детали»');
        await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { status: dataOf(draft).result ? 'details_review' : 'collecting' } });
        await (0, telegramBot_1.sendMessage)(draft.chatId, `Не получилось: ${(0, telegramBot_1.escapeHtml)(String(err?.message ?? err)).slice(0, 300)}\nНапишите «готово» ещё раз${dataOf(draft).result ? ' или опишите правку заново' : ''}.`);
    }
}
const sceneDir = (d) => `scenes/${d.id}/${d.data?.runId ?? 0}/`;
/** Дочерний вызов: рисует одну сцену, кладёт в Blob, а последняя завершившаяся запускает сборку слайдов. */
async function handleSceneJob(draftId, index) {
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.status !== 'details_working')
        return;
    const plan = planOf(draft);
    const scene = plan[index];
    if (!scene)
        return;
    const dir = sceneDir(draft);
    try {
        const refs = await loadPhotos(draft.photos, 3);
        if (!refs.length)
            throw new Error('не удалось загрузить фото');
        const img = await (0, geminiImage_service_1.generateSceneAuto)({ refs, scene: scene.prompt });
        await (0, blob_1.put)(`${dir}${index}.${img.mime.includes('jpeg') ? 'jpg' : 'png'}`, img.data, { access: 'public', contentType: img.mime, addRandomSuffix: false, token: env_1.env.blobToken });
    }
    catch (err) {
        const msg = String(err?.message ?? err).slice(0, 700);
        logger_1.logger.error({ err: msg, index }, '[ProductAgent] сцена не получилась');
        await (0, blob_1.put)(`${dir}${index}.fail`, msg, { access: 'public', contentType: 'text/plain', addRandomSuffix: false, token: env_1.env.blobToken }).catch(() => undefined);
    }
    const { blobs } = await (0, blob_1.list)({ prefix: dir, token: env_1.env.blobToken });
    if (blobs.length >= plan.length)
        await finalizeSlides(draftId, false);
}
/** Собирает слайды из готовых сцен (кто успел) и шаблонов, шлёт альбом и текст на одобрение. */
async function finalizeSlides(draftId, noScenes) {
    const claim = await prisma_1.prisma.productDraft.updateMany({ where: { id: draftId, status: 'details_working' }, data: { status: 'details_rendering' } });
    if (claim.count === 0)
        return; // кто-то другой уже собирает
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft)
        return;
    const prev = dataOf(draft);
    try {
        const result = prev.result;
        const plan = planOf(draft);
        const loaded = await loadPhotos(draft.photos, 4);
        const scenes = [];
        const errors = [];
        if (!noScenes) {
            const { blobs } = await (0, blob_1.list)({ prefix: sceneDir(draft), token: env_1.env.blobToken });
            for (let i = 0; i < plan.length; i++) {
                const ok = blobs.find((b) => /\.(png|jpg)$/.test(b.pathname) && b.pathname.startsWith(`${sceneDir(draft)}${i}.`));
                if (ok) {
                    const r = await fetch(ok.url);
                    if (r.ok) {
                        scenes.push({ img: { data: Buffer.from(await r.arrayBuffer()), mime: ok.pathname.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }, headline: plan[i].headline, caption: plan[i].caption });
                        continue;
                    }
                }
                const fail = blobs.find((b) => b.pathname === `${sceneDir(draft)}${i}.fail`);
                if (fail)
                    errors.push(await fetch(fail.url).then((r) => r.text()).catch(() => '?'));
            }
        }
        const pngs = await (0, detailSlides_service_1.renderDetailSlides)(result, loaded[0]?.data ?? null, loaded[0]?.mime ?? 'image/jpeg', { scenes, otherPhotos: loaded.slice(1) });
        const slides = [];
        for (let n = 0; n < pngs.length; n++) {
            const b = await (0, blob_1.put)(`details/${draftId}/r${draft.revisions}-${n + 1}.png`, pngs[n], { access: 'public', contentType: 'image/png', addRandomSuffix: true, token: env_1.env.blobToken });
            slides.push(b.url);
        }
        await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { data: { ...prev, slides }, status: 'details_review' } });
        if (!noScenes && errors.length) {
            await (0, telegramBot_1.sendMessage)(draft.chatId, `⚠️ ${errors.length} из ${plan.length} сцен не получились: ${(0, telegramBot_1.escapeHtml)(errors[0].slice(0, 700))}`);
        }
        await (0, telegramBot_1.sendPhotos)(draft.chatId, slides.slice(0, 10));
        await (0, telegramBot_1.sendMessage)(draft.chatId, formatDraft(result, draft.price, draft.oldPrice, draft.revisions), reviewButtons(draftId));
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[ProductAgent] ошибка сборки слайдов');
        await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { status: prev.slides ? 'details_review' : 'collecting' } });
        await (0, telegramBot_1.sendMessage)(draft.chatId, `Не получилось собрать слайды: ${(0, telegramBot_1.escapeHtml)(String(err?.message ?? err)).slice(0, 300)}\nНапишите «готово» ещё раз.`);
    }
}
async function approveDetails(draftId) {
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.status !== 'details_review' || !dataOf(draft).result)
        return;
    const d = dataOf(draft).result;
    const slides = dataOf(draft).slides ?? [];
    // Атомарно «забираем» черновик — повторный клик не создаст второй товар.
    const claim = await prisma_1.prisma.productDraft.updateMany({ where: { id: draftId, status: 'details_review' }, data: { status: 'done' } });
    if (claim.count === 0)
        return;
    try {
        if (isAttach(draft) && draft.productId) {
            const target = await prisma_1.prisma.product.findUnique({ where: { id: draft.productId }, select: { name: true, details: true } });
            if (!target)
                throw new Error('товар не найден');
            const current = Array.isArray(target.details) ? target.details : [];
            const merged = [...current, ...slides].slice(0, MAX_DETAILS);
            await prisma_1.prisma.product.update({ where: { id: draft.productId }, data: { details: merged } });
            await (0, telegramBot_1.sendMessage)(draft.chatId, `Готово: в «Детали» товара <b>${(0, telegramBot_1.escapeHtml)(target.name)}</b> теперь ${merged.length} из ${MAX_DETAILS}${current.length + slides.length > MAX_DETAILS ? ' (часть слайдов не влезла)' : ''}. Откройте товар в приложении и проверьте.`);
            return;
        }
        const article = draft.price != null
            ? await (0, shopArticle_1.maybeGenerateShopArticle)({ currentShopArticle: null, effectivePrice: draft.price, effectiveActive: false })
            : undefined;
        const product = await prisma_1.prisma.product.create({
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
        await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { productId: product.id } });
        await (0, telegramBot_1.sendMessage)(draft.chatId, `Сохранил: <b>${(0, telegramBot_1.escapeHtml)(d.name)}</b>${article ? ` (артикул ${article})` : ''}. Товар пока <b>не в продаже</b> — включите его в админке «My Market» после проверки. Инфографику подключим следующим этапом.\n\nМожно присылать следующий товар.`);
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[ProductAgent] не удалось создать товар');
        await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { status: 'details_review' } });
        await (0, telegramBot_1.sendMessage)(draft.chatId, `Не удалось сохранить товар: ${(0, telegramBot_1.escapeHtml)(String(err?.message ?? err)).slice(0, 300)}`);
    }
}
async function reviewSlices(draftId, sheet, grid) {
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft)
        return;
    try {
        const out = await (0, sheetSplit_service_1.splitSheet)(sheet, grid);
        const urls = [];
        for (let i = 0; i < out.slices.length; i++) {
            const b = await (0, blob_1.put)(`slices/${draftId}/${Date.now()}-${i + 1}.jpg`, out.slices[i], { access: 'public', contentType: 'image/jpeg', addRandomSuffix: true, token: env_1.env.blobToken });
            urls.push(b.url);
        }
        await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { status: 'slice_review', data: { ...dataOf(draft), grid: out.grid, slices: urls } } });
        await (0, telegramBot_1.sendPhotos)(draft.chatId, urls.slice(0, 10));
        await (0, telegramBot_1.sendMessage)(draft.chatId, `Нарезал на ${urls.length} картинок (${out.auto ? 'сетка определена сама' : 'сетка'} ${out.grid.rows}×${out.grid.cols}, по строкам слева направо). Верно? Если нарезано неправильно, напишите сетку, например <b>2x5</b>.`, [[{ text: '✅ Загрузить в «Детали»', callback_data: `d:ok:${draftId}` }, { text: '✖ Отмена', callback_data: `d:x:${draftId}` }]]);
    }
    catch (err) {
        await (0, telegramBot_1.sendMessage)(draft.chatId, `Не получилось нарезать: ${(0, telegramBot_1.escapeHtml)(String(err?.message ?? err)).slice(0, 300)}`);
    }
}
async function processSheet(draftId, fileId) {
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    if (!draft)
        return;
    const file = await (0, telegramBot_1.downloadFile)(fileId);
    const sheet = await (0, blob_1.put)(`sheets/${draftId}/${Date.now()}.jpg`, file.buffer, { access: 'public', contentType: (0, geminiImage_service_1.sniffImageMime)(file.buffer), token: env_1.env.blobToken });
    await prisma_1.prisma.productDraft.update({ where: { id: draftId }, data: { photos: { set: [sheet.url] } } });
    await reviewSlices(draftId, file.buffer, dataOf(draft).grid);
}
async function approveSlices(draftId) {
    const claim = await prisma_1.prisma.productDraft.updateMany({ where: { id: draftId, status: 'slice_review' }, data: { status: 'done' } });
    if (claim.count === 0)
        return;
    const draft = await prisma_1.prisma.productDraft.findUnique({ where: { id: draftId } });
    const slices = dataOf(draft).slices ?? [];
    if (!draft?.productId)
        return;
    const product = await prisma_1.prisma.product.findUnique({ where: { id: draft.productId }, select: { name: true, details: true } });
    if (!product)
        return void (await (0, telegramBot_1.sendMessage)(draft.chatId, 'Товар не найден (удалён?).'));
    const current = Array.isArray(product.details) ? product.details : [];
    const merged = [...current, ...slices].slice(0, MAX_DETAILS);
    await prisma_1.prisma.product.update({ where: { id: draft.productId }, data: { details: merged } });
    await (0, telegramBot_1.sendMessage)(draft.chatId, `Готово: в «Детали» товара <b>${(0, telegramBot_1.escapeHtml)(product.name)}</b> теперь ${merged.length} из ${MAX_DETAILS}${current.length + slices.length > MAX_DETAILS ? ' (часть не влезла)' : ''}. Проверьте в приложении.`);
}
async function addPhoto(chatId, fileId, caption) {
    let draft = await activeDraft(chatId);
    const sliceCap = caption ? parseSliceCommand(caption) : null;
    const rawCap = caption ? parseRawCommand(caption) : null;
    const articleCap = caption && /^\s*\d{7}\s*$/.test(caption) ? caption.trim() : null;
    const attachCap = caption ? parseAttachCommand(caption) : null;
    const inf = !sliceCap && !rawCap && !articleCap && !attachCap && caption ? inferIntent(caption) : null;
    const cmd = sliceCap?.query ?? rawCap ?? articleCap ?? attachCap ?? inf?.article ?? null;
    if (cmd && draft) {
        if (!(await supersede(chatId, draft)))
            return;
        draft = null;
    }
    if (cmd && !draft) {
        if (!(await startAttach(chatId, cmd, !!rawCap || inf?.mode === 'raw', sliceCap ? { grid: sliceCap.grid } : inf?.mode === 'slice' ? { grid: inf.grid } : undefined, !!articleCap || inf?.mode === 'ask')))
            return;
        draft = await activeDraft(chatId);
        caption = undefined;
    }
    if (draft && draft.status !== 'collecting') {
        await (0, telegramBot_1.sendMessage)(chatId, 'Сначала завершите текущий товар: одобрите, напишите правки или «отмена».');
        return;
    }
    const isNew = !draft;
    if (!draft) {
        const created = await prisma_1.prisma.productDraft.create({ data: { chatId } });
        const oldest = await prisma_1.prisma.productDraft.findFirst({ where: { chatId, status: 'collecting' }, orderBy: { createdAt: 'asc' } });
        if (oldest && oldest.id !== created.id) {
            await prisma_1.prisma.productDraft.delete({ where: { id: created.id } }).catch(() => undefined);
            draft = oldest;
        }
        else {
            draft = created;
        }
    }
    if (dataOf(draft).mode === 'slice')
        return processSheet(draft.id, fileId);
    if (dataOf(draft).mode === 'ask') {
        const f = await (0, telegramBot_1.downloadFile)(fileId);
        const b = await (0, blob_1.put)(`tg/${draft.id}/${Date.now()}.jpg`, f.buffer, { access: 'public', contentType: (0, geminiImage_service_1.sniffImageMime)(f.buffer), token: env_1.env.blobToken });
        const upd = await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { photos: { push: b.url } } });
        if (upd.photos.length === 1) {
            await (0, telegramBot_1.sendMessage)(chatId, 'Получил. Что сделать с картинками?', [
                [{ text: '✂️ Нарезать лист на слайды', callback_data: `d:m:${draft.id}:slice` }],
                [{ text: '📥 Загрузить как есть', callback_data: `d:m:${draft.id}:raw` }],
                [{ text: '🤖 Сделать красивые Детали (ИИ)', callback_data: `d:m:${draft.id}:ai` }],
            ]);
        }
        return;
    }
    if (draft.photos.length >= MAX_PHOTOS) {
        await (0, telegramBot_1.sendMessage)(chatId, `Максимум ${MAX_PHOTOS} фото на товар. Напишите «готово».`);
        return;
    }
    const file = await (0, telegramBot_1.downloadFile)(fileId);
    const blob = await (0, blob_1.put)(`tg/${draft.id}/${Date.now()}.jpg`, file.buffer, { access: 'public', contentType: (0, geminiImage_service_1.sniffImageMime)(file.buffer), token: env_1.env.blobToken });
    const attach = isAttach(draft);
    const prices = caption && !attach ? (0, productAgent_service_1.parsePrices)(caption) : {};
    await prisma_1.prisma.productDraft.update({
        where: { id: draft.id },
        data: {
            photos: { push: blob.url },
            ...(prices.price ? { price: prices.price, oldPrice: prices.oldPrice ?? null } : {}),
            ...(caption && !attach && !prices.price ? { notes: [draft.notes, caption].filter(Boolean).join('\n') } : {}),
        },
    });
    if (isNew && !attach) {
        const g = await (0, sheetSplit_service_1.peekGrid)(file.buffer).catch(() => null);
        if (g) {
            await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { data: { mode: 'await_article', grid: g } } });
            await (0, telegramBot_1.sendMessage)(chatId, `Похоже на лист из ${g.rows * g.cols} слайдов (${g.rows}×${g.cols}). Чтобы нарезать и загрузить их в «Детали», пришлите <b>артикул товара</b> (7 цифр). Если это фото нового товара — напишите «готово».`);
        }
        else {
            await (0, telegramBot_1.sendMessage)(chatId, 'Принял фото. ' + HELP);
        }
    }
}
async function handleText(chatId, text) {
    const t = text.trim();
    const low = t.toLowerCase();
    const draft = await activeDraft(chatId);
    if (low === '/start' || low === '/help')
        return (0, telegramBot_1.sendMessage)(chatId, HELP);
    if (['отмена', '/cancel', 'cancel'].includes(low)) {
        if (draft)
            await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { status: 'cancelled' } });
        return (0, telegramBot_1.sendMessage)(chatId, draft ? 'Отменил. Можно начинать новый товар.' : 'Нечего отменять.');
    }
    if (draft && dataOf(draft).mode === 'await_article' && draft.photos.length) {
        const inf0 = inferIntent(t);
        if (inf0)
            return bindSheetToProduct(draft.id, chatId, inf0.article, inf0.grid ?? dataOf(draft).grid);
    }
    if (/^\d{7}$/.test(t)) {
        if (!(await supersede(chatId, draft)))
            return;
        await startAttach(chatId, t, false, undefined, true);
        return;
    }
    const sliceCmd = parseSliceCommand(t);
    if (sliceCmd) {
        if (!(await supersede(chatId, draft)))
            return;
        await startAttach(chatId, sliceCmd.query, false, { grid: sliceCmd.grid });
        return;
    }
    const rawCmd = parseRawCommand(t);
    if (rawCmd) {
        if (!(await supersede(chatId, draft)))
            return;
        await startAttach(chatId, rawCmd, true);
        return;
    }
    const cmd = parseAttachCommand(t);
    if (cmd) {
        if (!(await supersede(chatId, draft)))
            return;
        await startAttach(chatId, cmd);
        return;
    }
    const inf = inferIntent(t);
    if (inf && dataOf(draft).mode !== 'slice' && draft?.status !== 'slice_review') {
        if (draft && dataOf(draft).mode === 'ask' && draft.photos.length && inf.mode === 'slice') {
            await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { data: { mode: 'slice', ...(inf.grid ? { grid: inf.grid } : {}) } } });
            const buf = Buffer.from(await (await fetch(draft.photos[0])).arrayBuffer());
            await (0, telegramBot_1.sendMessage)(chatId, 'Режу лист…');
            return reviewSlices(draft.id, buf, inf.grid);
        }
        if (!draft || draft.status === 'collecting' && !dataOf(draft).mode) {
            if (!(await supersede(chatId, draft)))
                return;
            await startAttach(chatId, inf.article, inf.mode === 'raw', inf.mode === 'slice' ? { grid: inf.grid } : undefined, inf.mode === 'ask');
            return;
        }
    }
    if (!draft)
        return (0, telegramBot_1.sendMessage)(chatId, HELP);
    if (dataOf(draft).mode === 'slice') {
        const g = (0, sheetSplit_service_1.parseGrid)(t);
        if (!g)
            return (0, telegramBot_1.sendMessage)(chatId, draft.status === 'slice_review' ? 'Нажмите «Загрузить в «Детали»» или напишите сетку, например 2x5. Отмена — «отмена».' : 'Жду лист с картинками файлом. Сетку можно написать заранее, например 2x5.');
        if (draft.status === 'collecting') {
            await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { data: { ...dataOf(draft), grid: g } } });
            return (0, telegramBot_1.sendMessage)(chatId, `Сетка ${g.rows}×${g.cols}. Теперь пришлите лист файлом.`);
        }
        const sheetUrl = draft.photos[0];
        if (!sheetUrl)
            return (0, telegramBot_1.sendMessage)(chatId, 'Лист потерялся, пришлите его заново.');
        const buf = Buffer.from(await (await fetch(sheetUrl)).arrayBuffer());
        await (0, telegramBot_1.sendMessage)(chatId, `Режу заново ${g.rows}×${g.cols}…`);
        return reviewSlices(draft.id, buf, g);
    }
    if (draft.status === 'collecting' && isAttach(draft)) {
        if (['готово', '/done', 'done', 'все', 'всё'].includes(low)) {
            if (!draft.photos.length)
                return (0, telegramBot_1.sendMessage)(chatId, 'Фото ещё нет. Пришлите хотя бы одно.');
            return dataOf(draft).raw ? finishRaw(draft.id) : finishAttach(draft.id);
        }
        return (0, telegramBot_1.sendMessage)(chatId, 'Жду фото для «Деталей». Когда всё отправили — «готово», отмена — «отмена».');
    }
    if (draft.status === 'collecting') {
        if (['готово', '/done', 'done', 'все', 'всё'].includes(low)) {
            if (!draft.photos.length)
                return (0, telegramBot_1.sendMessage)(chatId, 'Фото ещё нет. Пришлите хотя бы одно.');
            const claim = await prisma_1.prisma.productDraft.updateMany({ where: { id: draft.id, status: 'collecting' }, data: { status: 'details_working' } });
            if (claim.count === 0)
                return;
            await (0, telegramBot_1.sendMessage)(chatId, `Читаю ${draft.photos.length} фото${draft.price ? '' : ' (цены нет — напишите её потом, я пока подготовлю карточку)'}…`);
            (0, functions_1.waitUntil)(runDetails(draft.id, null));
            return;
        }
        const prices = (0, productAgent_service_1.parsePrices)(t);
        if (prices.price && t.length <= 40) {
            await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { price: prices.price, oldPrice: prices.oldPrice ?? null } });
            return (0, telegramBot_1.sendMessage)(chatId, `Цена: ${money(prices.price)}${prices.oldPrice ? ` (было ${money(prices.oldPrice)})` : ''}. Ещё фото или «готово».`);
        }
        await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { notes: [draft.notes, t].filter(Boolean).join('\n') } });
        return (0, telegramBot_1.sendMessage)(chatId, 'Записал примечание. Ещё фото или «готово».');
    }
    if (draft.status === 'details_working' || draft.status === 'details_rendering') {
        const stale = Date.now() - draft.updatedAt.getTime() > 150_000;
        if (stale && draft.status === 'details_working') {
            await (0, telegramBot_1.sendMessage)(chatId, 'Долго рисуется — собираю из того, что успело.');
            return (0, functions_1.waitUntil)(finalizeSlides(draft.id, false));
        }
        if (stale) {
            await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { status: (dataOf(draft).slides ? 'details_review' : 'collecting') } });
            return (0, telegramBot_1.sendMessage)(chatId, 'Сборка зависла. Напишите «готово» ещё раз.');
        }
        return (0, telegramBot_1.sendMessage)(chatId, 'Ещё работаю над карточкой, минутку…');
    }
    if (draft.status === 'details_review') {
        if (draft.revisions >= MAX_REVISIONS)
            return (0, telegramBot_1.sendMessage)(chatId, 'Слишком много правок подряд. Одобрите текущий вариант или «отмена».', reviewButtons(draft.id));
        const prices = (0, productAgent_service_1.parsePrices)(t);
        const onlyPrice = prices.price && t.length <= 40;
        if (onlyPrice) {
            await prisma_1.prisma.productDraft.update({ where: { id: draft.id }, data: { price: prices.price, oldPrice: prices.oldPrice ?? null } });
            return (0, telegramBot_1.sendMessage)(chatId, `Цена обновлена: ${money(prices.price)}${prices.oldPrice ? ` (было ${money(prices.oldPrice)})` : ''}.`, reviewButtons(draft.id));
        }
        const claim = await prisma_1.prisma.productDraft.updateMany({
            where: { id: draft.id, status: 'details_review' },
            data: { status: 'details_working', revisions: { increment: 1 } },
        });
        if (claim.count === 0)
            return;
        await (0, telegramBot_1.sendMessage)(chatId, 'Понял, переделываю…');
        (0, functions_1.waitUntil)(runDetails(draft.id, t));
    }
}
async function handleCallback(cb) {
    const chatId = cb.message?.chat.id;
    if (!chatId || !(0, telegramBot_1.isAllowedChat)(chatId))
        return;
    const [, action, id, choice] = (cb.data ?? '').split(':');
    await (0, telegramBot_1.answerCallback)(cb.id);
    if (!id)
        return;
    if (action === 'ok') {
        const cur = await prisma_1.prisma.productDraft.findUnique({ where: { id }, select: { status: true } });
        return cur?.status === 'slice_review' ? approveSlices(id) : approveDetails(id);
    }
    if (action === 'm') {
        const d = await prisma_1.prisma.productDraft.findUnique({ where: { id } });
        if (!d || d.status !== 'collecting' || dataOf(d).mode !== 'ask' || !d.photos.length)
            return;
        if (choice === 'slice') {
            await prisma_1.prisma.productDraft.update({ where: { id }, data: { data: { mode: 'slice' } } });
            const buf = Buffer.from(await (await fetch(d.photos[0])).arrayBuffer());
            await (0, telegramBot_1.sendMessage)(String(chatId), 'Режу лист…');
            return reviewSlices(id, buf, undefined);
        }
        if (choice === 'raw') {
            await prisma_1.prisma.productDraft.update({ where: { id }, data: { data: { mode: 'attach', raw: true } } });
            return finishRaw(id);
        }
        if (choice === 'ai') {
            await prisma_1.prisma.productDraft.update({ where: { id }, data: { data: { mode: 'attach' } } });
            return finishAttach(id);
        }
        return;
    }
    if (action === 'x') {
        await prisma_1.prisma.productDraft.updateMany({ where: { id, status: { in: ['collecting', 'details_review', 'slice_review'] } }, data: { status: 'cancelled' } });
        await (0, telegramBot_1.sendMessage)(String(chatId), 'Отменил. Можно начинать новый товар.');
    }
}
/** Точка входа вебхука. Чужие чаты игнорируются молча. */
async function handleUpdate(update) {
    try {
        // Ответы операторов в чатах поддержки (реплай, «#номер текст», кнопки sup:…) — не черновики товаров.
        if (await (0, support_service_1.handleSupportUpdate)(update))
            return;
        // Агент карточек товаров (инфографика) выключен: бот теперь — чат поддержки.
        // Включить обратно — переменная окружения TELEGRAM_PRODUCT_AGENT=on.
        if (process.env.TELEGRAM_PRODUCT_AGENT !== 'on') {
            const chat = update.message?.chat.id;
            if (chat && (0, telegramBot_1.isAllowedChat)(chat) && update.message) {
                await (0, telegramBot_1.sendMessage)(String(chat), 'Сейчас нет открытого чата с клиентом. Новый чат придёт с кнопкой «Взять». Подсказка — /help').catch(() => undefined);
            }
            if (update.callback_query)
                await (0, telegramBot_1.answerCallback)(update.callback_query.id);
            return;
        }
        if (update.callback_query)
            return await handleCallback(update.callback_query);
        const m = update.message;
        if (!m || !(0, telegramBot_1.isAllowedChat)(m.chat.id))
            return;
        const chatId = String(m.chat.id);
        if (m.photo?.length)
            return await addPhoto(chatId, m.photo[m.photo.length - 1].file_id, m.caption);
        if (m.document?.mime_type?.startsWith('image/'))
            return await addPhoto(chatId, m.document.file_id, m.caption);
        if (m.text)
            return await handleText(chatId, m.text);
    }
    catch (err) {
        logger_1.logger.error({ err: String(err?.message ?? err) }, '[ProductAgent] ошибка обработки апдейта');
        const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
        if (chat && (0, telegramBot_1.isAllowedChat)(chat))
            await (0, telegramBot_1.sendMessage)(String(chat), 'Что-то пошло не так, попробуйте ещё раз.').catch(() => undefined);
    }
}
//# sourceMappingURL=productDraft.service.js.map