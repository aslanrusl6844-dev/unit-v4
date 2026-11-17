"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.assistantRouter = void 0;
exports.stripUiMarkers = stripUiMarkers;
exports.sanitizeMessages = sanitizeMessages;
const express_1 = __importStar(require("express"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const shopCategories_1 = require("../config/shopCategories");
const support_routes_1 = require("./support.routes");
const speechToText_service_1 = require("../services/speechToText.service");
const assistant_service_1 = require("../services/assistant.service");
exports.assistantRouter = (0, express_1.Router)();
// Свой x-app-key (роутер смонтирован раньше shopRouter, его проверка сюда не доходит).
exports.assistantRouter.use((req, res, next) => {
    if (!env_1.env.shopAppKey)
        return res.status(503).json({ error: 'SHOP_APP_KEY не настроен' });
    if (req.header('x-app-key') !== env_1.env.shopAppKey)
        return res.status(401).json({ error: 'Неверный x-app-key' });
    next();
});
// Чат с живым оператором (ответы через Telegram-бот).
exports.assistantRouter.use('/support', support_routes_1.supportRouter);
// Простейший лимит на IP: 20 запросов в минуту (память функции; от случайных циклов, не от атак).
const hits = new Map();
function limited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > 20;
}
function stripUiMarkers(text) {
    return text.replace(/\{\{\s*все:[^}]*\}\}/g, '').replace(/\[\[[^\]]*\]\]/g, '').trim();
}
function sanitizeMessages(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = raw
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        // Служебные маркеры приложения (подборка {{все:…}}, кнопки [[…]]) модели не нужны.
        .map((m) => ({ role: m.role, content: stripUiMarkers(String(m.content)).slice(0, 2000) }))
        .filter((m) => m.content.trim())
        .slice(-20);
    while (out.length && out[0].role !== 'user')
        out.shift();
    return out;
}
/**
 * Голосовое сообщение (как в WhatsApp): тело запроса — сам файл (audio/mp4, до ~4 МБ), в ответ {text}.
 * Дальше приложение отправляет этот текст Баурсаку обычным запросом.
 */
exports.assistantRouter.post('/transcribe', express_1.default.raw({ type: () => true, limit: speechToText_service_1.MAX_AUDIO_BYTES }), async (req, res) => {
    if (limited(req.ip || 'x'))
        return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
    const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (audio.length < 800)
        return res.status(400).json({ error: 'Пустая запись' });
    try {
        const t0 = Date.now();
        const lang = String(req.header('x-app-lang') ?? '').slice(0, 5).toLowerCase() || null;
        const text = await (0, speechToText_service_1.transcribeAudio)({ audio, mime: (0, speechToText_service_1.audioMime)(req.header('content-type')), lang });
        logger_1.logger.info({ ms: Date.now() - t0, bytes: audio.length, chars: text.length }, 'assistant transcribe ok');
        res.json({ text });
    }
    catch (e) {
        logger_1.logger.error({ err: e }, 'assistant transcribe error');
        res.status(502).json({ error: 'Не удалось распознать голос, попробуйте ещё раз' });
    }
});
exports.assistantRouter.post('/', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
        return res.status(503).json({ error: 'Ассистент пока не подключён (нет ANTHROPIC_API_KEY)' });
    if (limited(req.ip || 'x'))
        return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
    const messages = sanitizeMessages(req.body?.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user')
        return res.status(400).json({ error: 'Нужен хотя бы один вопрос' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
        const { items: catalog, showcases } = await (0, assistant_service_1.loadCatalog)();
        const lastUsers = messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
        // Названа витрина/бренд — сначала её товары, потом остальные совпадения.
        const named = (0, assistant_service_1.matchShowcases)(showcases, lastUsers).map((x) => x.title);
        const inNamed = named.length ? catalog.filter((p) => p.showcases?.some((t) => named.includes(t))) : [];
        let found = (0, assistant_service_1.rankProducts)(inNamed.length ? inNamed : catalog, lastUsers, 14);
        if (inNamed.length && found.length < 14)
            found = [...found, ...inNamed.filter((p) => !found.includes(p))].slice(0, 14);
        if (!found.length)
            found = (0, assistant_service_1.diverseSample)(catalog, 12);
        const system = (0, assistant_service_1.buildSystemPrompt)(found, [...shopCategories_1.SHOP_CATEGORIES], showcases);
        const toolSkus = [];
        const raw = await (0, assistant_service_1.runAssistant)({
            apiKey, model: process.env.ASSISTANT_MODEL || assistant_service_1.DEFAULT_MODEL, system, messages, catalog: { items: catalog, showcases }, signal: ac.signal,
            // Звёздочки markdown приложение не рисует — убираем их на лету.
            onDelta: (t) => { const c = t.replace(/\*/g, ''); if (c)
                send('delta', { text: c }); },
            onToolResult: (name, result) => { if (name === 'search_products')
                toolSkus.push(...(0, assistant_service_1.skusFromToolResult)(result)); },
        });
        let full = raw.replace(/\*/g, '');
        // Назвал товар без маркера — дописываем маркеры, чтобы у каждого была карточка с фото и корзиной.
        const realSkus = new Set(catalog.map((p) => p.sku));
        const missing = (0, assistant_service_1.missingProductSkus)(full, catalog, Math.max(0, 4 - (0, assistant_service_1.extractSkus)(full).filter((s) => realSkus.has(s)).length));
        if (missing.length)
            send('delta', { text: `\n${missing.map((s) => `{{${s}}}`).join(' ')}` });
        if (missing.length)
            full += `\n${missing.map((s) => `{{${s}}}`).join(' ')}`;
        // Модель забыла {{все:…}} — собираем подборку сами, чтобы была кнопка «Смотреть все товары».
        const bySkuAll = new Map(catalog.map((p) => [p.sku, p]));
        const candidates = [...toolSkus.map((s) => bySkuAll.get(s)).filter((p) => !!p), ...(0, assistant_service_1.rankProducts)(catalog, lastUsers, 60), ...found];
        const related = (0, assistant_service_1.fallbackRelatedSkus)(full, candidates, catalog);
        if (related.length)
            send('delta', { text: `\n{{все:${related.join(',')}}}` });
        const bySku = new Map(catalog.map((p) => [p.sku, p]));
        const cards = (0, assistant_service_1.extractSkus)(full).map((s) => bySku.get(s)).filter(Boolean).slice(0, 4);
        send('products', { items: cards });
        send('done', {});
    }
    catch (e) {
        logger_1.logger.error({ err: e }, 'assistant error');
        send('error', { message: 'Ассистент временно недоступен, попробуйте ещё раз' });
    }
    finally {
        res.end();
    }
});
//# sourceMappingURL=assistant.routes.js.map