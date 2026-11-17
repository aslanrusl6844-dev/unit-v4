"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSISTANT_TOOLS = exports.DEFAULT_MODEL = void 0;
exports.rankProducts = rankProducts;
exports.looseKey = looseKey;
exports.matchShowcases = matchShowcases;
exports.extractSkus = extractSkus;
exports.skusFromToolResult = skusFromToolResult;
exports.missingProductSkus = missingProductSkus;
exports.fallbackRelatedSkus = fallbackRelatedSkus;
exports.diverseSample = diverseSample;
exports.loadCatalog = loadCatalog;
exports.productLine = productLine;
exports.buildSystemPrompt = buildSystemPrompt;
exports.streamClaude = streamClaude;
exports.findShowcase = findShowcase;
exports.toolGetShowcase = toolGetShowcase;
exports.toolSearchProducts = toolSearchProducts;
exports.runTool = runTool;
exports.runAssistant = runAssistant;
const prisma_1 = require("../db/prisma");
const shop_routes_1 = require("../routes/shop.routes");
const assistantKnowledge_1 = require("../config/assistantKnowledge");
exports.DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
// Грубый «стемминг»: режем окончание, чтобы «платья» находило «платье».
const stem = (w) => (w.length > 5 ? w.slice(0, -2) : w.length > 3 ? w.slice(0, -1) : w);
const tokens = (s) => norm(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 2).map(stem);
/** Ранжирование каталога по запросу (чистая функция — легко тестировать). */
function rankProducts(items, query, limit = 8) {
    const q = tokens(query);
    if (!q.length)
        return [];
    const scored = items.map((it) => {
        const name = norm(it.name);
        const meta = norm([it.category, it.subcategory, it.type].filter(Boolean).join(' '));
        const info = norm(it.info ?? '');
        const brands = norm((it.showcases ?? []).join(' '));
        let score = 0;
        for (const t of q) {
            if (brands.includes(t))
                score += 3;
            if (name.includes(t))
                score += 3;
            else if (meta.includes(t))
                score += 2;
            else if (info.includes(t))
                score += 1;
        }
        return { it, score };
    }).filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.it);
}
const CYR = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
    п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'u', я: 'a',
};
/** «На слух»: кириллица → латиница, повторы букв схлопнуты, только буквы и цифры. «Цель-29» и «CELL 29» дают одно: cel29. */
function looseKey(s) {
    const lat = norm(s).split('').map((ch) => (ch in CYR ? CYR[ch] : ch)).join('');
    return lat.replace(/[^a-z0-9]+/g, '').replace(/(.)\1+/g, '$1');
}
/** Витрины, названные в запросе (по границе слова, чтобы «9-9» не цеплялось за любое число). */
function matchShowcases(showcases, query) {
    const q = ' ' + norm(query).replace(/[^a-zа-я0-9-]+/g, ' ') + ' ';
    const qt = new Set(tokens(query));
    const qKey = looseKey(query);
    return showcases.filter((sc) => {
        const t = norm(sc.title).replace(/[^a-zа-я0-9-]+/g, ' ').trim();
        if (!t)
            return false;
        if (q.includes(' ' + t + ' '))
            return true;
        // На слух («Цель-29» = CELL 29): сравниваем «ключи»; короткие названия (9-9) так не ловим — слишком много случайных совпадений.
        const tKey = looseKey(sc.title);
        if (tKey.length >= 4 && qKey.includes(tKey))
            return true;
        const parts = tokens(sc.title);
        return parts.length > 0 && parts.every((w) => w.length >= 3 && qt.has(w));
    });
}
/** Достаём артикулы из маркеров {{артикул}} (формат приложения); {{витрина:id}} пропускаем. */
function extractSkus(text) {
    const out = [];
    for (const m of text.matchAll(/\{\{\s*([^}:]+?)\s*\}\}/g))
        if (!out.includes(m[1]))
            out.push(m[1]);
    return out;
}
/** Артикулы из ответа инструмента (строки вида «- Название | артикул 123 | …»). */
function skusFromToolResult(result) {
    const out = [];
    for (const m of result.matchAll(/\|\s*артикул\s+([^\s|]+)/g))
        if (!out.includes(m[1]))
            out.push(m[1]);
    return out;
}
/**
 * Страховка: модель назвала товар из каталога, но забыла маркер {{артикул}} — тогда клиент видит текст
 * без фото. Ищем в ответе названия товаров (полностью или первые 3+ значимых слова) и возвращаем артикулы
 * без маркеров (не больше limit), чтобы дописать маркеры в конец ответа — приложение покажет карточки.
 */
function missingProductSkus(text, items, limit = 4) {
    // Маркер с выдуманным артикулом карточку не даёт — считаем только настоящие.
    const known = new Set(items.map((p) => p.sku));
    const have = new Set(extractSkus(text).filter((s) => known.has(s)));
    // Сравниваем без пробелов и знаков: «Cell29 Celinica» в ответе = «Cell 29 Celinica» в каталоге.
    const compact = (v) => norm(v).replace(/[^\p{L}\p{N}]+/gu, '');
    const t = compact(text);
    const out = [];
    for (const p of items) {
        if (have.has(p.sku) || out.length >= limit)
            continue;
        const words = norm(p.name).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);
        if (words.length < 2)
            continue;
        // Начало названия (3–4 слова) — модель часто пишет название короче, без хвоста «50 мл».
        const heads = [words.slice(0, 4), words.slice(0, 3)].map((w) => compact(w.join(' ')));
        if (heads.some((h) => h.length >= 12 && t.includes(h)))
            out.push(p.sku);
    }
    return out;
}
/**
 * Страховка для кнопки «Смотреть все товары»: модель показала карточки, но забыла {{все:…}}.
 * Берём кандидатов (сначала из её поисков, потом из найденных по вопросу) того же подраздела,
 * что и показанные карточки, без уже показанных. Пусто — кнопки не будет.
 */
function fallbackRelatedSkus(text, candidates, items, limit = 30) {
    if (/\{\{\s*все:/.test(text))
        return [];
    const bySku = new Map(items.map((p) => [p.sku, p]));
    const shown = extractSkus(text).map((s) => bySku.get(s)).filter((p) => !!p);
    if (!shown.length)
        return [];
    const group = (p) => norm(p.subcategory || p.category || '');
    const groups = new Set(shown.map(group).filter(Boolean));
    const shownSkus = new Set(shown.map((p) => p.sku));
    const out = [];
    for (const p of candidates) {
        if (out.length >= limit)
            break;
        if (shownSkus.has(p.sku) || out.includes(p.sku))
            continue;
        if (!groups.has(group(p)))
            continue;
        out.push(p.sku);
    }
    return out;
}
/** Если по словам ничего не нашлось — разнообразная выборка: по одному-два товара из каждого раздела. */
function diverseSample(items, limit = 12) {
    const seen = new Map();
    const out = [];
    for (const it of items) {
        const k = it.category ?? '';
        if ((seen.get(k) ?? 0) >= 2)
            continue;
        seen.set(k, (seen.get(k) ?? 0) + 1);
        out.push(it);
        if (out.length >= limit)
            break;
    }
    return out;
}
let cache = null;
const CACHE_MS = 2 * 60_000; // каталог ассистента обновляется не реже, чем раз в 2 минуты
async function loadCatalog() {
    if (cache && Date.now() - cache.at < CACHE_MS)
        return cache.data;
    const scs = await prisma_1.prisma.showcase.findMany({ where: { published: true }, orderBy: { sortOrder: 'asc' } });
    const links = scs.length
        ? await prisma_1.prisma.showcaseProduct.findMany({ where: { showcaseId: { in: scs.map((x) => x.id) } } })
        : [];
    const inShowcaseIds = [...new Set(links.map((l) => l.productId))];
    const [open, inSc] = await Promise.all([
        prisma_1.prisma.product.findMany({ where: shop_routes_1.SHOP_VISIBLE_WHERE, take: 3000 }),
        inShowcaseIds.length
            ? prisma_1.prisma.product.findMany({ where: { ...shop_routes_1.SHOP_VISIBLE_IN_SHOWCASE_WHERE, id: { in: inShowcaseIds } } })
            : Promise.resolve([]),
    ]);
    const titleById = new Map(scs.map((x) => [String(x.id), String(x.title)]));
    const scByProduct = new Map();
    const countBySc = new Map();
    for (const l of links) {
        scByProduct.set(l.productId, [...(scByProduct.get(l.productId) ?? []), titleById.get(l.showcaseId) ?? '']);
    }
    const seen = new Set();
    const items = [];
    for (const r of [...open, ...inSc]) {
        if (seen.has(r.id))
            continue;
        seen.add(r.id);
        const p = (0, shop_routes_1.toShopProduct)(r);
        const chars = (p.characteristics ?? []).map((c) => `${c.name}: ${c.value}`).join('; ');
        const clean = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
        const sc = scByProduct.get(r.id) ?? [];
        for (const l of links)
            if (l.productId === r.id)
                countBySc.set(l.showcaseId, (countBySc.get(l.showcaseId) ?? 0) + 1);
        items.push({
            sku: String(p.sku), name: p.name, category: p.category ?? null, subcategory: p.subcategory ?? null,
            type: p.type ?? null, price: p.price ?? null, stock: p.stock ?? null,
            info: clean([p.description, p.composition, chars].join(' ')),
            details: [
                p.description ? `описание: ${clean(p.description).slice(0, 500)}` : '',
                p.composition ? `состав: ${clean(p.composition).slice(0, 700)}` : '',
                chars ? `характеристики: ${clean(chars).slice(0, 300)}` : '',
            ].filter(Boolean).join(' | '),
            showcases: sc,
            image: Array.isArray(p.images) && p.images[0] ? String(p.images[0]) : null,
        });
    }
    const showcases = scs.map((x) => ({
        id: x.id, title: x.title, type: x.type, description: x.description ?? null, count: countBySc.get(x.id) ?? 0,
    }));
    const data = { items, showcases };
    cache = { at: Date.now(), data };
    return data;
}
/** Строка товара для промпта и ответов инструментов. */
function productLine(p) {
    return `- ${p.name} | артикул ${p.sku} | ${[p.category, p.subcategory].filter(Boolean).join(' / ')}${p.showcases?.length ? ' | витрина: ' + p.showcases.join(', ') : ''} | ${p.price} ₸ | ${p.stock != null && p.stock <= 0 ? 'НЕТ В НАЛИЧИИ' : 'в наличии'}${p.details ? ' | ' + p.details : ''}`;
}
function buildSystemPrompt(found, categories, showcases = []) {
    const list = found.length
        ? found.map(productLine).join('\n')
        : '(ничего не найдено — не придумывай товары, уточни запрос или предложи посмотреть раздел)';
    const sc = showcases.length
        ? showcases.map((x) => `- ${x.title} (${x.type === 'brand' ? 'бренд' : 'магазин'}) | id: ${x.id} | товаров: ${x.count}${x.description ? ' | ' + x.description.replace(/\s+/g, ' ').slice(0, 200) : ''}`).join('\n')
        : '(витрин нет)';
    return `${assistantKnowledge_1.PERSONA}\n\n${assistantKnowledge_1.SHOP_KNOWLEDGE}\n\nРАЗДЕЛЫ КАТАЛОГА: ${categories.join(', ')}\n\nВИТРИНЫ (бренды и магазины на главной; витрину можно предложить маркером {{витрина:id}}):\n${sc}\n\nНАЙДЕННЫЕ ТОВАРЫ:\n${list}`;
}
/** Стрим ответа Claude. onDelta вызывается с чистыми кусками текста. */
async function streamClaude(opts) {
    const f = opts.fetchImpl ?? fetch;
    const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 600, stream: true, system: opts.system, messages: opts.messages }),
        signal: opts.signal,
    });
    if (!res.ok || !res.body)
        throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:'))
                continue;
            try {
                const ev = JSON.parse(line.slice(5).trim());
                if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                    full += ev.delta.text;
                    opts.onDelta(ev.delta.text);
                }
                else if (ev.type === 'error')
                    throw new Error(ev.error?.message ?? 'stream error');
            }
            catch (e) {
                if (e?.message && !(e instanceof SyntaxError))
                    throw e;
            }
        }
    }
    return full;
}
// ---------------------------------------------------------------------------
// Инструменты: ассистент сам открывает витрину целиком и ищет по всему каталогу.
// ---------------------------------------------------------------------------
exports.ASSISTANT_TOOLS = [
    {
        name: 'get_showcase',
        description: 'Все товары одной витрины (бренда или магазина) с описанием, составом, ценой и наличием. Название или id — из списка витрин.',
        input_schema: { type: 'object', properties: { showcase: { type: 'string', description: 'Название витрины как в списке (например CELL 29) или её id' } }, required: ['showcase'] },
    },
    {
        name: 'search_products',
        description: 'Поиск товаров по всему каталогу по словам запроса (название, тип, раздел, бренд, описание).',
        input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Сколько товаров вернуть (до 30)' } }, required: ['query'] },
    },
];
const SHOWCASE_TOOL_LIMIT = 60;
/** Витрина по id, названию или «на слух». null — не нашли. */
function findShowcase(showcases, ref) {
    const r = String(ref ?? '').trim();
    if (!r)
        return null;
    const byId = showcases.find((s) => s.id === r);
    if (byId)
        return byId;
    const n = norm(r);
    const exact = showcases.find((s) => norm(s.title) === n);
    if (exact)
        return exact;
    const key = looseKey(r);
    if (key.length >= 2) {
        const k = showcases.find((s) => looseKey(s.title) === key);
        if (k)
            return k;
    }
    return matchShowcases(showcases, r)[0] ?? null;
}
function toolGetShowcase(catalog, ref) {
    const sc = findShowcase(catalog.showcases, ref);
    if (!sc) {
        return `Витрина «${ref}» не найдена. Есть витрины: ${catalog.showcases.map((s) => s.title).join(', ') || '(нет)'}.`;
    }
    const items = catalog.items.filter((p) => p.showcases?.includes(sc.title));
    const shown = items.slice(0, SHOWCASE_TOOL_LIMIT);
    const head = `Витрина «${sc.title}» (${sc.type === 'brand' ? 'бренд' : 'магазин'}), товаров всего: ${items.length}${items.length > shown.length ? `, показано ${shown.length}` : ''}.`;
    return shown.length ? `${head}\n${shown.map(productLine).join('\n')}` : `${head}\nТоваров в витрине сейчас нет.`;
}
function toolSearchProducts(catalog, query, limit) {
    const n = Math.min(Math.max(Math.round(Number(limit) || 10), 1), 30);
    const found = rankProducts(catalog.items, String(query ?? ''), n);
    if (!found.length)
        return `По запросу «${query}» ничего не найдено.`;
    return `Найдено товаров: ${found.length}.\n${found.map(productLine).join('\n')}`;
}
function runTool(catalog, name, input) {
    if (name === 'get_showcase')
        return toolGetShowcase(catalog, input?.showcase);
    if (name === 'search_products')
        return toolSearchProducts(catalog, input?.query, input?.limit);
    return `Неизвестный инструмент ${name}`;
}
/** Один запрос к Claude со стримом: текст уходит в onDelta, вызовы инструментов собираются. */
async function streamRound(opts) {
    const f = opts.fetchImpl ?? fetch;
    const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            model: opts.model, max_tokens: opts.maxTokens, stream: true, system: opts.system, messages: opts.messages,
            tools: exports.ASSISTANT_TOOLS, ...(opts.toolsOff ? { tool_choice: { type: 'none' } } : {}),
        }),
        signal: opts.signal,
    });
    if (!res.ok || !res.body)
        throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let stopReason = '';
    const toolUses = [];
    let cur = null;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:'))
                continue;
            let ev;
            try {
                ev = JSON.parse(line.slice(5).trim());
            }
            catch {
                continue;
            }
            if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
                cur = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
            }
            else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                text += ev.delta.text;
                opts.onDelta(ev.delta.text);
            }
            else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && cur) {
                cur.json += ev.delta.partial_json ?? '';
            }
            else if (ev.type === 'content_block_stop' && cur) {
                let input = {};
                try {
                    input = cur.json ? JSON.parse(cur.json) : {};
                }
                catch {
                    input = {};
                }
                toolUses.push({ id: cur.id, name: cur.name, input });
                cur = null;
            }
            else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
                stopReason = ev.delta.stop_reason;
            }
            else if (ev.type === 'error') {
                throw new Error(ev.error?.message ?? 'stream error');
            }
        }
    }
    return { text, toolUses, stopReason };
}
/**
 * Ответ ассистента с инструментами: Claude может до maxRounds раз открыть витрину или поискать товары,
 * потом пишет ответ. Возвращает весь текст (для карточек товаров по маркерам {{артикул}}).
 */
async function runAssistant(opts) {
    const maxRounds = opts.maxRounds ?? 4;
    const convo = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    let full = '';
    for (let round = 0;; round++) {
        if (full && !full.endsWith('\n')) {
            opts.onDelta('\n\n');
            full += '\n\n';
        }
        const r = await streamRound({
            apiKey: opts.apiKey, model: opts.model, system: opts.system, messages: convo, maxTokens: opts.maxTokens ?? 2000,
            toolsOff: round >= maxRounds, onDelta: (t) => { full += t; opts.onDelta(t); }, signal: opts.signal, fetchImpl: opts.fetchImpl,
        });
        if (r.stopReason !== 'tool_use' || !r.toolUses.length)
            return full.trim();
        const blocks = [];
        if (r.text.trim())
            blocks.push({ type: 'text', text: r.text });
        for (const t of r.toolUses)
            blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
        convo.push({ role: 'assistant', content: blocks });
        convo.push({
            role: 'user',
            content: r.toolUses.map((t) => {
                const result = runTool(opts.catalog, t.name, t.input);
                opts.onToolResult?.(t.name, result);
                return { type: 'tool_result', tool_use_id: t.id, content: result };
            }),
        });
    }
}
//# sourceMappingURL=assistant.service.js.map