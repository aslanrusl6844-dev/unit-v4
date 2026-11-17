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
exports.yardRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const blob_1 = require("@vercel/blob");
const prisma_1 = require("../db/prisma");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const shop_routes_1 = require("./shop.routes");
const push_service_1 = require("../services/push.service");
const yard_service_1 = require("../services/yard.service");
exports.yardRouter = (0, express_1.Router)();
/**
 * Тот же x-app-key, что и у всего /api/shop/* — «Двор» живёт под тем же
 * приложением покупателя, путь /api/shop/yard/....
 */
exports.yardRouter.use((req, res, next) => {
    if (!env_1.env.shopAppKey) {
        return res.status(503).json({ error: 'SHOP_APP_KEY не настроен на сервере — Двор недоступен' });
    }
    const key = req.header('x-app-key');
    if (key !== env_1.env.shopAppKey) {
        return res.status(401).json({ error: 'Неверный или отсутствующий заголовок x-app-key' });
    }
    next();
});
// =====================================================================
// Вакансия -> Заявка -> Одобрение -> Кабинет (та же логика, что у вакансии
// курьера: YardInvite/YardApplication зеркалят ShopCourierInvite/
// ShopCourierApplication).
// =====================================================================
/**
 * Вакансия на этот телефон — только она, ничего о чужих. Нет вакансии —
 * пустой ответ (null): в приложении раздел «Двор» для этого номера пустой,
 * кнопки подачи заявки нет.
 */
exports.yardRouter.get('/yard/invite', async (req, res) => {
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(String(req.query.phone ?? ''));
    if (!normalizedPhone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const invite = await prisma_1.prisma.yardInvite.findUnique({ where: { phone: normalizedPhone } });
        res.json(invite ?? null);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/invite упал');
        res.status(500).json({ error: 'Не удалось получить вакансию', details: String(err?.message ?? err) });
    }
});
/**
 * Общее видео-инструкция «Как пользоваться» для покупателей — одна ссылка на весь
 * сервер (YardSettings, строка "main"). Без телефона, тот же x-app-key. Нет
 * ссылки — { videoUrl: null }, приложение блок не рисует.
 */
exports.yardRouter.get('/yard/instruction', async (_req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const row = await prisma_1.prisma.yardSettings.findUnique({ where: { id: 'main' } });
        res.json({ videoUrl: row?.instructionUrl ?? null });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/instruction упал');
        res.status(500).json({ error: 'Не удалось получить видео-инструкцию', details: String(err?.message ?? err) });
    }
});
const applySchema = zod_1.z.object({
    phone: zod_1.z.string().min(1),
    shopName: zod_1.z.string().min(1),
    shopPhoto: zod_1.z.string().url().optional().nullable(),
    lat: zod_1.z.number(),
    lng: zod_1.z.number(),
});
/**
 * Заявка на магазин — без вакансии на этот телефон отвечаем 403. Имя,
 * фамилия и ИИН берутся из вакансии, не из того, что прислал бы заявитель.
 * Одна заявка на телефон: повторная с того же номера, пока ещё pending,
 * обновляет название/фото/точку, решённую заявку задним числом не трогает.
 */
exports.yardRouter.post('/yard/apply', async (req, res) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(parsed.data.phone);
    if (!normalizedPhone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const invite = await prisma_1.prisma.yardInvite.findUnique({ where: { phone: normalizedPhone } });
        if (!invite)
            return res.status(403).json({ error: 'На этот телефон нет вакансии — заявка недоступна' });
        const existing = await prisma_1.prisma.yardApplication.findUnique({ where: { phone: normalizedPhone } });
        if (existing) {
            if (existing.status === 'pending') {
                const updated = await prisma_1.prisma.yardApplication.update({
                    where: { phone: normalizedPhone },
                    data: { shopName: parsed.data.shopName, shopPhoto: parsed.data.shopPhoto ?? null, lat: parsed.data.lat, lng: parsed.data.lng },
                });
                return res.json({ status: updated.status });
            }
            return res.json({ status: existing.status }); // approved/rejected — решение уже принято
        }
        const created = await prisma_1.prisma.yardApplication.create({
            data: {
                phone: normalizedPhone,
                firstName: invite.firstName,
                lastName: invite.lastName,
                iin: invite.iin,
                shopName: parsed.data.shopName,
                shopPhoto: parsed.data.shopPhoto ?? null,
                lat: parsed.data.lat,
                lng: parsed.data.lng,
                status: 'pending',
            },
        });
        res.status(201).json({ status: created.status });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/apply упал');
        res.status(500).json({ error: 'Не удалось отправить заявку', details: String(err?.message ?? err) });
    }
});
// Загрузка фото товара двора — x-app-key, не админ. JSON base64.
const yardUploadSchema = zod_1.z.object({
    kind: zod_1.z.literal('image'),
    filename: zod_1.z.string().min(1),
    contentType: zod_1.z.string().min(1),
    dataBase64: zod_1.z.string().min(1),
});
exports.yardRouter.post('/yard/upload-photo', async (req, res) => {
    const parsed = yardUploadSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    if (!env_1.env.blobToken)
        return res.status(501).json({ error: 'Blob не настроен' });
    const { filename, contentType, dataBase64 } = parsed.data;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        return res.status(400).json({ error: `Формат не поддерживается: ${contentType}` });
    }
    try {
        const buffer = Buffer.from(dataBase64, 'base64');
        if (buffer.length > 3 * 1024 * 1024)
            return res.status(413).json({ error: 'Файл слишком большой' });
        const random = Math.random().toString(36).slice(2, 10);
        const pathname = `yard/items/${random}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const blob = await (0, blob_1.put)(pathname, buffer, { access: 'public', contentType, token: env_1.env.blobToken });
        res.json({ url: blob.url });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] Ошибка загрузки фото');
        res.status(500).json({ error: 'Не удалось загрузить фото', details: String(err?.message ?? err) });
    }
});
// Регистрация push-токена.
exports.yardRouter.post('/yard/push-token', async (req, res) => {
    const { phone, token } = req.body ?? {};
    if (!phone || !token)
        return res.status(400).json({ error: 'Нужны phone и token' });
    const normalized = (0, shop_routes_1.normalizePhone)(phone);
    if (!normalized)
        return res.status(400).json({ error: 'Некорректный телефон' });
    try {
        await prisma_1.prisma.shopCustomerPushToken.upsert({
            where: { phone: normalized },
            update: { token },
            create: { phone: normalized, token },
        });
        res.json({ ok: true });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/push-token упал');
        res.status(500).json({ error: 'Не удалось сохранить токен', details: String(err?.message ?? err) });
    }
});
// Debug: проверить, что FIREBASE_KEY загружен и токен получается.
exports.yardRouter.get('/yard/push-tokens', async (req, res) => {
    const phone = req.query.phone;
    if (phone) {
        const normalized = (0, shop_routes_1.normalizePhone)(phone) || phone;
        const devices = await prisma_1.prisma.shopCustomerPushToken.findMany({ where: { phone: normalized } });
        return res.json({ phone: normalized, tokens: devices.map(d => ({ phone: d.phone, token: d.token.slice(0, 20) + '...' })) });
    }
    const all = await prisma_1.prisma.shopCustomerPushToken.findMany({ take: 10 });
    res.json({ count: all.length, tokens: all.map(d => ({ phone: d.phone, token: d.token.slice(0, 20) + '...' })) });
});
exports.yardRouter.get('/yard/push-test', async (req, res) => {
    const phone = req.query.phone;
    if (!phone)
        return res.status(400).json({ error: 'phone required' });
    const normalized = (0, shop_routes_1.normalizePhone)(phone) || phone;
    try {
        const devices = await prisma_1.prisma.shopCustomerPushToken.findMany({ where: { phone: normalized } });
        const results = [];
        const token = await (async () => {
            const keyJson = env_1.env.firebaseKey;
            if (!keyJson)
                return null;
            const key = JSON.parse(keyJson);
            const now = Math.floor(Date.now() / 1000);
            const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
            const payload = Buffer.from(JSON.stringify({
                iss: key.client_email, sub: key.client_email,
                aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
                scope: 'https://www.googleapis.com/auth/firebase.messaging',
            })).toString('base64url');
            const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
            const sign = crypto.createSign('RSA-SHA256');
            sign.update(header + '.' + payload);
            const signature = sign.sign(key.private_key, 'base64url');
            const jwt = header + '.' + payload + '.' + signature;
            const r = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
            });
            const d = await r.json();
            return d.access_token ?? null;
        })();
        if (!token)
            return res.json({ ok: false, error: 'no access token' });
        for (const device of devices) {
            const r = await fetch('https://fcm.googleapis.com/v1/projects/my-market-3e032/messages:send', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: { token: device.token, notification: { title: 'Тест', body: 'Проверка пуша' } } }),
            });
            const body = await r.text();
            results.push({ status: r.status, body: body.slice(0, 300) });
        }
        res.json({ ok: true, devices: devices.length, results });
    }
    catch (err) {
        res.status(500).json({ error: String(err?.message ?? err) });
    }
});
exports.yardRouter.get('/yard/push-debug', async (req, res) => {
    const keyJson = env_1.env.firebaseKey;
    if (!keyJson)
        return res.json({ ok: false, error: 'FIREBASE_KEY не задан' });
    try {
        const key = JSON.parse(keyJson);
        const hasEmail = !!key.client_email;
        const hasKey = !!key.private_key;
        res.json({ ok: true, hasEmail, hasKey, email: key.client_email?.slice(0, 30) });
    }
    catch (err) {
        res.json({ ok: false, error: 'JSON не парсится', details: String(err?.message ?? err) });
    }
});
/** Статус заявки по телефону — "none", если заявки нет вовсе. Только по этому номеру, ничего о чужих. */
exports.yardRouter.get('/yard/me', async (req, res) => {
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(String(req.query.phone ?? ''));
    if (!normalizedPhone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const application = await prisma_1.prisma.yardApplication.findUnique({ where: { phone: normalizedPhone } });
        res.json({ status: application?.status ?? 'none' });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/me упал');
        res.status(500).json({ error: 'Не удалось получить статус заявки', details: String(err?.message ?? err) });
    }
});
// =====================================================================
// Кабинет и полка — открываются только после одобрения (YardShop создаётся
// исключительно через POST /yard-admin/applications/:id/approve).
// =====================================================================
function parseLatLng(latRaw, lngRaw) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        return null;
    return { lat, lng };
}
/** Три товара полки для предпросмотра в списке дворов — только активные. */
async function previewItems(shopId) {
    return prisma_1.prisma.yardItem.findMany({
        where: { shopId, active: true, archived: false },
        orderBy: { id: 'asc' },
        take: 3,
        select: { name: true, price: true, photo: true },
    });
}
/**
 * Магазины рядом — имя, метры, координаты (точка на карте), 3 товара. БЕЗ телефона.
 * Параметр radius — радиус покупателя в метрах (по умолчанию 500). В ответ
 * попадает магазин, только если расстояние ≤ radius покупателя И ≤ radiusMeters
 * самого магазина: дальше радиуса магазина его не видно, даже при большом radius.
 * Подписка просрочена/магазин выключен — в список не попадает.
 */
exports.yardRouter.get('/yard/nearby', async (req, res) => {
    const point = parseLatLng(req.query.lat, req.query.lng);
    if (!point)
        return res.status(400).json({ error: 'Некорректные координаты' });
    const buyerRadius = (0, yard_service_1.yardParseBuyerRadius)(req.query.radius);
    if (buyerRadius === null)
        return res.status(400).json({ error: 'Некорректный radius (метры, число больше 0)' });
    try {
        const shops = await prisma_1.prisma.yardShop.findMany({});
        const nearby = shops
            .filter((s) => (0, yard_service_1.yardShopIsLive)(s))
            .map((s) => ({ ...s, meters: (0, yard_service_1.yardDistanceMeters)(point.lat, point.lng, s.lat, s.lng) }))
            .filter((s) => s.meters <= buyerRadius && s.meters <= (0, yard_service_1.yardShopRadius)(s))
            .sort((a, b) => a.meters - b.meters);
        const result = await Promise.all(nearby.map(async (s) => ({
            id: s.id,
            name: s.name,
            photo: s.photo,
            meters: Math.round(s.meters),
            // Координаты магазина — красная точка на карте покупателя. Только широта и
            // долгота: телефона и прочих данных магазина в списке по-прежнему нет.
            lat: s.lat,
            lng: s.lng,
            items: await previewItems(s.id),
        })));
        res.json(result);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/nearby упал');
        res.status(500).json({ error: 'Не удалось получить список дворов', details: String(err?.message ?? err) });
    }
});
/** Полка одного магазина — только если точка клиента в радиусе этого магазина (radiusMeters). */
exports.yardRouter.get('/yard/shop/:id', async (req, res) => {
    const point = parseLatLng(req.query.lat, req.query.lng);
    if (!point)
        return res.status(400).json({ error: 'Некорректные координаты' });
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { id: req.params.id } });
        if (!shop || !(0, yard_service_1.yardShopIsLive)(shop))
            return res.status(404).json({ error: 'Двор не найден' });
        // Радиус проверяется в списке nearby. Здесь открываем полку.
        const items = await prisma_1.prisma.yardItem.findMany({ where: { shopId: shop.id, active: true, archived: false }, orderBy: { id: 'asc' } });
        res.json({
            id: shop.id,
            name: shop.name,
            photo: shop.photo,
            bannerUrl: shop.bannerUrl ?? null,
            videoUrl: shop.videoUrl ?? null,
            tickerText: shop.tickerText ?? null,
            items: items.map((i) => ({
                id: i.id,
                name: i.name,
                price: i.price,
                stock: i.stock,
                photo: i.photo,
                category: i.category,
            })),
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/shop/:id упал');
        res.status(500).json({ error: 'Не удалось получить полку', details: String(err?.message ?? err) });
    }
});
const createOrderSchema = zod_1.z.object({
    shopId: zod_1.z.string().min(1),
    lat: zod_1.z.number(),
    lng: zod_1.z.number(),
    buyerPhone: zod_1.z.string().min(1),
    // Имя в профиле может быть пустым: заказ всё равно должен создаться (имя — «Покупатель»).
    buyerName: zod_1.z.string().trim().optional(),
    address: zod_1.z.string().trim().max(300).optional(),
    // Адрес доставки: подъезд, этаж, квартира, домофон (необязательные; приложение может прислать их
    // следом через POST /yard/order-address).
    entrance: zod_1.z.string().trim().max(100).optional(),
    floor: zod_1.z.string().trim().max(100).optional(),
    apartment: zod_1.z.string().trim().max(100).optional(),
    intercom: zod_1.z.string().trim().max(100).optional(),
    items: zod_1.z.array(zod_1.z.object({ itemId: zod_1.z.string().min(1), qty: zod_1.z.number().int().positive() })).min(1),
});
/** Пустая строка -> null, undefined -> не трогать. */
function cleanAddressPart(v) {
    if (v === undefined)
        return undefined;
    const t = (v ?? '').trim();
    return t === '' ? null : t;
}
/**
 * Создание заказа — остаток НЕ списываем (только при подтверждении оплаты).
 * Телефон магазина в ответ не кладём. У покупателя кнопки отмены нет —
 * эндпоинта на отмену заказа в этом файле намеренно нет.
 */
exports.yardRouter.post('/yard/orders', async (req, res) => {
    // Каждая попытка оформить заказ оставляет след в логах: раньше сбой был тихим и «заказа нет» нельзя было объяснить.
    const reject = (status, reason, extra = {}) => {
        logger_1.logger.warn({ status, reason, ...extra }, '[Yard] POST /yard/orders отклонён');
        return status;
    };
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(reject(400, 'неверные данные', { fields: Object.keys(parsed.error.flatten().fieldErrors) })).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    }
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(parsed.data.buyerPhone);
    if (!normalizedPhone)
        return res.status(reject(400, 'некорректный телефон')).json({ error: 'Некорректный номер телефона' });
    logger_1.logger.info({ shopId: parsed.data.shopId, buyer: normalizedPhone.slice(-4), lines: parsed.data.items.length, pointKnown: !(parsed.data.lat === 0 && parsed.data.lng === 0) }, '[Yard] POST /yard/orders получен');
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { id: parsed.data.shopId } });
        if (!shop || !(0, yard_service_1.yardShopIsLive)(shop))
            return res.status(reject(404, 'двор не найден или не активен', { shopId: parsed.data.shopId })).json({ error: 'Двор не найден' });
        // Точка покупателя 0,0 — приложение не знает местоположение (геолокация выключена): заказ не
        // отклоняем и расстояние не считаем. Реальная точка вне радиуса магазина по-прежнему отклоняется.
        const pointUnknown = parsed.data.lat === 0 && parsed.data.lng === 0;
        const shopRadius = (0, yard_service_1.yardShopRadius)(shop);
        if (!pointUnknown) {
            const distance = (0, yard_service_1.yardDistanceMeters)(parsed.data.lat, parsed.data.lng, shop.lat, shop.lng);
            if (distance > shopRadius)
                return res.status(reject(403, 'вне радиуса', { distance: Math.round(distance), shopRadius })).json({ error: `Вы вне радиуса ${shopRadius} м от этого двора` });
        }
        const itemIds = parsed.data.items.map((i) => i.itemId);
        const shelfItems = await prisma_1.prisma.yardItem.findMany({ where: { id: { in: itemIds }, shopId: shop.id, active: true, archived: false } });
        const shelfById = new Map(shelfItems.map((i) => [i.id, i]));
        const orderItemsData = [];
        for (const line of parsed.data.items) {
            const shelfItem = shelfById.get(line.itemId);
            if (!shelfItem)
                return res.status(reject(400, 'товар не найден на полке', { itemId: line.itemId })).json({ error: `Товар ${line.itemId} не найден на этой полке` });
            if (shelfItem.stock < line.qty)
                return res.status(reject(400, 'не хватает на полке', { itemId: line.itemId, stock: shelfItem.stock, qty: line.qty })).json({ error: `На полке недостаточно «${shelfItem.name}»` });
            orderItemsData.push({ itemId: shelfItem.id, name: shelfItem.name, price: shelfItem.price, qty: line.qty });
        }
        const total = orderItemsData.reduce((sum, i) => sum + i.price * i.qty, 0);
        const publicId = await (0, yard_service_1.generateYardPublicId)();
        const order = await prisma_1.prisma.yardOrder.create({
            data: {
                publicId,
                shopId: shop.id,
                buyerPhone: normalizedPhone,
                buyerName: parsed.data.buyerName || 'Покупатель',
                address: cleanAddressPart(parsed.data.address) ?? null,
                entrance: cleanAddressPart(parsed.data.entrance) ?? null,
                floor: cleanAddressPart(parsed.data.floor) ?? null,
                apartment: cleanAddressPart(parsed.data.apartment) ?? null,
                intercom: cleanAddressPart(parsed.data.intercom) ?? null,
                lat: pointUnknown ? null : parsed.data.lat,
                lng: pointUnknown ? null : parsed.data.lng,
                total,
                status: 'waiting_payment',
                items: { create: orderItemsData },
            },
            include: { items: true },
        });
        logger_1.logger.info({ orderId: order.id, publicId: order.publicId, total: order.total }, '[Yard] Заказ создан');
        res.status(201).json({
            id: order.id,
            publicId: order.publicId,
            status: order.status,
            total: order.total,
            items: order.items,
            shop: { id: shop.id, name: shop.name },
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders упал');
        res.status(500).json({ error: 'Не удалось создать заказ', details: String(err?.message ?? err) });
    }
});
function toBuyerOrderDto(order) {
    const phoneVisible = yard_service_1.YARD_PHONE_VISIBLE_STATUSES.includes(order.status);
    return {
        id: order.id,
        publicId: order.publicId,
        status: order.status,
        total: order.total,
        createdAt: order.createdAt,
        paidAt: order.paidAt ?? null,
        items: order.items,
        shop: {
            id: order.shop.id,
            name: order.shop.name,
            phone: phoneVisible ? order.shop.phone : null,
        },
    };
}
/** Заказы покупателя — только его собственные, по телефону. Чужой номер чужой полки не видит. */
exports.yardRouter.get('/yard/orders', async (req, res) => {
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(String(req.query.phone ?? ''));
    if (!normalizedPhone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const orders = await prisma_1.prisma.yardOrder.findMany({
            where: { buyerPhone: normalizedPhone },
            include: { items: true, shop: true },
            orderBy: { createdAt: 'desc' },
        });
        res.json(orders.map(toBuyerOrderDto));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/orders упал');
        res.status(500).json({ error: 'Не удалось получить заказы', details: String(err?.message ?? err) });
    }
});
const orderAddressSchema = zod_1.z.object({
    orderId: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(1),
    address: zod_1.z.string().trim().max(300).optional(),
    entrance: zod_1.z.string().trim().max(100).optional(),
    floor: zod_1.z.string().trim().max(100).optional(),
    apartment: zod_1.z.string().trim().max(100).optional(),
    intercom: zod_1.z.string().trim().max(100).optional(),
});
/**
 * Адрес доставки к заказу — присылает покупатель следом за заказом (улица и дом, подъезд,
 * этаж, квартира, домофон). Только покупатель этого заказа и только пока заказ не закрыт.
 * Меняются лишь присланные поля; пустая строка очищает поле.
 */
exports.yardRouter.post('/yard/order-address', async (req, res) => {
    const parsed = orderAddressSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    const phone = (0, shop_routes_1.normalizePhone)(parsed.data.phone);
    if (!phone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const order = await prisma_1.prisma.yardOrder.findUnique({ where: { id: parsed.data.orderId } });
        if (!order)
            return res.status(404).json({ error: 'Заказ не найден' });
        if (order.buyerPhone !== phone)
            return res.status(403).json({ error: 'Адрес может добавить только покупатель этого заказа' });
        if (['done', 'no_payment', 'not_picked', 'out_of_stock'].includes(order.status)) {
            return res.status(409).json({ error: 'Заказ уже закрыт' });
        }
        const data = {};
        for (const key of ['address', 'entrance', 'floor', 'apartment', 'intercom']) {
            const v = cleanAddressPart(parsed.data[key]);
            if (v !== undefined)
                data[key] = v;
        }
        if (Object.keys(data).length === 0)
            return res.status(400).json({ error: 'Нет полей адреса' });
        await prisma_1.prisma.yardOrder.update({ where: { id: order.id }, data });
        res.json({ ok: true });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/order-address упал');
        res.status(500).json({ error: 'Не удалось сохранить адрес', details: String(err?.message ?? err) });
    }
});
/**
 * Заказ целиком — для покупателя и для продавца (по телефону). Накладная для продавца:
 * номер и имя покупателя, адрес (улица, подъезд, этаж, квартира, домофон), расстояние от
 * магазина и радиус магазина — адрес и расстояние только с «Оплачено». Телефон магазина
 * покупателю — только с «Принял», как и в списке заказов.
 */
function toOrderDetailDto(order, role) {
    const showAddress = role === 'buyer' || yard_service_1.YARD_SELLER_DETAIL_STATUSES.includes(order.status);
    return {
        id: order.id,
        publicId: order.publicId,
        status: (0, yard_service_1.yardAppStatus)(order.status),
        serverStatus: order.status,
        total: order.total,
        createdAt: order.createdAt,
        paidAt: order.paidAt ?? null,
        shopId: order.shopId,
        shopName: order.shop.name,
        shop: {
            id: order.shop.id,
            name: order.shop.name,
            phone: role === 'seller' || yard_service_1.YARD_PHONE_VISIBLE_STATUSES.includes(order.status) ? order.shop.phone : null,
        },
        buyerName: order.buyerName,
        buyerPhone: order.buyerPhone,
        address: showAddress ? order.address ?? null : null,
        entrance: showAddress ? order.entrance ?? null : null,
        floor: showAddress ? order.floor ?? null : null,
        apartment: showAddress ? order.apartment ?? null : null,
        intercom: showAddress ? order.intercom ?? null : null,
        distanceMeters: showAddress ? (0, yard_service_1.yardOrderDistance)(order, order.shop) : null,
        shopRadiusMeters: (0, yard_service_1.yardShopRadius)(order.shop),
        items: (order.items ?? []).map((i) => ({ id: i.id, itemId: i.itemId, name: i.name, price: i.price, qty: i.qty })),
        messages: (order.messages ?? []).map((m) => ({
            id: m.id, from: m.from, text: m.text, imageUrl: m.imageUrl, createdAt: m.createdAt,
        })),
    };
}
exports.yardRouter.get('/yard/orders/:id', async (req, res) => {
    const phone = (0, shop_routes_1.normalizePhone)(String(req.query.phone ?? ''));
    if (!phone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const order = await prisma_1.prisma.yardOrder.findUnique({
            where: { id: req.params.id },
            include: { items: true, shop: true, messages: { orderBy: { createdAt: 'asc' } } },
        });
        if (!order)
            return res.status(404).json({ error: 'Заказ не найден' });
        const isSeller = phone === order.shop.phone;
        if (!isSeller && phone !== order.buyerPhone)
            return res.status(403).json({ error: 'Этот номер не участвует в заказе' });
        res.json(toOrderDetailDto(order, isSeller ? 'seller' : 'buyer'));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/orders/:id упал');
        res.status(500).json({ error: 'Не удалось получить заказ', details: String(err?.message ?? err) });
    }
});
/** Определяет, какая сторона заказа шлёт сообщение — покупатель или магазин. */
async function resolveYardParty(orderId, phone) {
    const order = await prisma_1.prisma.yardOrder.findUnique({ where: { id: orderId }, include: { shop: true } });
    if (!order)
        return null;
    const normalized = (0, shop_routes_1.normalizePhone)(phone);
    if (!normalized)
        return null;
    if (normalized === order.buyerPhone)
        return 'buyer';
    if (normalized === order.shop.phone)
        return 'shop';
    return null;
}
const receiptSchema = zod_1.z.object({ phone: zod_1.z.string().min(1), imageUrl: zod_1.z.string().url() });
/** Скрин чека в чат заказа — от любой из двух сторон, чужой номер отклоняем. */
exports.yardRouter.post('/yard/orders/:id/receipt', async (req, res) => {
    const parsed = receiptSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const from = await resolveYardParty(req.params.id, parsed.data.phone);
        if (!from)
            return res.status(403).json({ error: 'Этот номер не участвует в заказе' });
        const message = await prisma_1.prisma.yardMessage.create({
            data: { orderId: req.params.id, from, imageUrl: parsed.data.imageUrl },
        });
        res.status(201).json(message);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders/:id/receipt упал');
        res.status(500).json({ error: 'Не удалось отправить скрин чека', details: String(err?.message ?? err) });
    }
});
const messageSchema = zod_1.z.object({ phone: zod_1.z.string().min(1), text: zod_1.z.string().min(1).max(1000) });
/** Сообщение в чат заказа — чат только внутри заказа, не публично. */
exports.yardRouter.post('/yard/orders/:id/message', async (req, res) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const from = await resolveYardParty(req.params.id, parsed.data.phone);
        if (!from)
            return res.status(403).json({ error: 'Этот номер не участвует в заказе' });
        const message = await prisma_1.prisma.yardMessage.create({
            data: { orderId: req.params.id, from, text: parsed.data.text },
        });
        res.status(201).json(message);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders/:id/message упал');
        res.status(500).json({ error: 'Не удалось отправить сообщение', details: String(err?.message ?? err) });
    }
});
// =====================================================================
// Чат магазина БЕЗ заказа. Клиент пишет магазину до покупки, продавец
// отвечает. Ветка переписки = (магазин, телефон клиента). Каждый пишет и
// читает только со своего телефона; чужой магазин и чужие ветки не читаются.
// Телефон магазина в ответах не отдаётся никогда. Заказы, полки и
// существующий чат ЗАКАЗА (YardMessage) не затрагиваются.
// =====================================================================
const shopMessageSchema = zod_1.z.object({
    shopId: zod_1.z.string().min(1),
    buyerPhone: zod_1.z.string().min(1),
    // Кто пишет. Не передан — пишет сам клиент (phone = buyerPhone). Продавец
    // передаёт свой телефон, а в buyerPhone — клиента, которому отвечает.
    phone: zod_1.z.string().min(1).optional(),
    text: zod_1.z.string().max(1000).optional(),
    imageUrl: zod_1.z.string().url().optional(),
});
/**
 * Написать магазину / ответить клиенту. Клиент пишет в живой магазин (подписка
 * действует). Продавец отвечает только в ветку, где клиент уже писал первым —
 * по этому методу нельзя написать на произвольный номер.
 */
exports.yardRouter.post('/yard/shops/:id/messages', async (req, res) => {
    const parsed = shopMessageSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    if (parsed.data.shopId !== req.params.id)
        return res.status(400).json({ error: 'shopId в теле не совпадает с адресом' });
    const buyerPhone = (0, shop_routes_1.normalizePhone)(parsed.data.buyerPhone);
    if (!buyerPhone)
        return res.status(400).json({ error: 'Некорректный номер клиента' });
    const senderPhone = parsed.data.phone ? (0, shop_routes_1.normalizePhone)(parsed.data.phone) : buyerPhone;
    if (!senderPhone)
        return res.status(400).json({ error: 'Некорректный номер отправителя' });
    const text = parsed.data.text?.trim() || null;
    const imageUrl = parsed.data.imageUrl ?? null;
    if (!text && !imageUrl)
        return res.status(400).json({ error: 'Нужен text или imageUrl' });
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { id: req.params.id } });
        if (!shop)
            return res.status(404).json({ error: 'Двор не найден' });
        let from;
        if (senderPhone === shop.phone) {
            if (buyerPhone === shop.phone)
                return res.status(400).json({ error: 'Укажите номер клиента, которому отвечаете' });
            from = 'shop';
        }
        else if (senderPhone === buyerPhone) {
            if (!(0, yard_service_1.yardShopIsLive)(shop))
                return res.status(404).json({ error: 'Двор не найден' });
            from = 'buyer';
        }
        else {
            return res.status(403).json({ error: 'Писать можно только со своего номера' });
        }
        const message = await prisma_1.prisma.yardShopMessage.create({
            data: { shopId: shop.id, buyerPhone, from, text, imageUrl },
        });
        // Push только получателю. Нормализуем оба телефона.
        const shopPhoneNorm = (0, shop_routes_1.normalizePhone)(shop.phone) || shop.phone;
        const buyerPhoneNorm = (0, shop_routes_1.normalizePhone)(buyerPhone) || buyerPhone;
        const recipient = from === 'buyer' ? shopPhoneNorm : buyerPhoneNorm;
        const senderName = from === 'buyer' ? 'Покупатель' : (shop.name || 'Магазин');
        logger_1.logger.info({ from, recipient, shopPhone: shop.phone, buyerPhone }, '[Yard] Пуш: отправляю');
        (0, push_service_1.sendPush)(recipient, { title: senderName, body: (text ?? '').slice(0, 100), data: { shopId: shop.id, type: 'chat' } })
            .then(() => logger_1.logger.info({ recipient }, '[Yard] Пуш отправлен'))
            .catch((err) => logger_1.logger.error({ err, recipient }, '[Yard] Пуш не ушёл'));
        res.status(201).json({ id: message.id, from: message.from, text: message.text, imageUrl: message.imageUrl, createdAt: message.createdAt });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/shops/:id/messages упал');
        res.status(500).json({ error: 'Не удалось отправить сообщение', details: String(err?.message ?? err) });
    }
});
/**
 * Читать переписку. ?phone= — кто читает (обязателен). Клиент видит только
 * свою ветку с этим магазином. Продавец (phone = телефон магазина) видит
 * входящие своего магазина: всю переписку или одну ветку, если указан
 * ?buyerPhone=. Чужой магазин и чужие ветки — 403.
 */
exports.yardRouter.get('/yard/shops/:id/messages', async (req, res) => {
    const reader = (0, shop_routes_1.normalizePhone)(String(req.query.phone ?? ''));
    if (!reader)
        return res.status(400).json({ error: 'Укажите свой номер телефона (phone)' });
    const buyerQuery = req.query.buyerPhone ? (0, shop_routes_1.normalizePhone)(String(req.query.buyerPhone)) : null;
    if (req.query.buyerPhone && !buyerQuery)
        return res.status(400).json({ error: 'Некорректный номер клиента' });
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { id: req.params.id } });
        if (!shop)
            return res.status(404).json({ error: 'Двор не найден' });
        const isSeller = reader === shop.phone;
        if (!isSeller) {
            if (buyerQuery && buyerQuery !== reader)
                return res.status(403).json({ error: 'Чужая переписка недоступна' });
            if (!(0, yard_service_1.yardShopIsLive)(shop))
                return res.status(404).json({ error: 'Двор не найден' });
        }
        const where = isSeller
            ? { shopId: shop.id, ...(buyerQuery ? { buyerPhone: buyerQuery } : {}) }
            : { shopId: shop.id, buyerPhone: reader };
        const latest = await prisma_1.prisma.yardShopMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
        const messages = [...latest].reverse();
        res.json(messages.map((m) => ({
            id: m.id,
            from: m.from,
            text: m.text,
            imageUrl: m.imageUrl,
            createdAt: m.createdAt,
            // Продавцу нужно знать, чья это ветка; клиент и так знает, что это его.
            ...(isSeller ? { buyerPhone: m.buyerPhone } : {}),
        })));
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/shops/:id/messages упал');
        res.status(500).json({ error: 'Не удалось получить сообщения', details: String(err?.message ?? err) });
    }
});
/**
 * Кабинет «Я магазин» — по телефону. YardShop существует ТОЛЬКО после
 * одобрения заявки (создаётся в POST /yard-admin/applications/:id/approve)
 * — до одобрения здесь просто shop:null, не ошибка. Заказы отдаём с
 * телефоном покупателя ТОЛЬКО с accepted и дальше — симметрично покупателю.
 */
exports.yardRouter.get('/yard/mine', async (req, res) => {
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(String(req.query.phone ?? ''));
    if (!normalizedPhone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { phone: normalizedPhone } });
        if (!shop)
            return res.json({ shop: null, items: [], orders: [] });
        const [items, orders] = await Promise.all([
            prisma_1.prisma.yardItem.findMany({ where: { shopId: shop.id }, orderBy: { id: 'asc' } }),
            prisma_1.prisma.yardOrder.findMany({ where: { shopId: shop.id }, include: { items: true }, orderBy: { createdAt: 'desc' } }),
        ]);
        res.json({
            shop,
            items,
            orders: orders.map((o) => {
                // Накладная: адрес, подъезд, этаж, квартира, домофон и расстояние — сразу после «Оплачено».
                // Номер покупателя — с самого начала (он и так виден продавцу в чате), по нему приложение
                // находит заказ для «Подтвердить оплату».
                const details = yard_service_1.YARD_SELLER_DETAIL_STATUSES.includes(o.status);
                return {
                    id: o.id,
                    publicId: o.publicId,
                    status: (0, yard_service_1.yardAppStatus)(o.status),
                    serverStatus: o.status,
                    total: o.total,
                    createdAt: o.createdAt,
                    paidAt: o.paidAt ?? null,
                    items: o.items,
                    buyerName: o.buyerName,
                    buyerPhone: o.buyerPhone,
                    address: details ? o.address ?? null : null,
                    entrance: details ? o.entrance ?? null : null,
                    floor: details ? o.floor ?? null : null,
                    apartment: details ? o.apartment ?? null : null,
                    intercom: details ? o.intercom ?? null : null,
                    distanceMeters: details ? (0, yard_service_1.yardOrderDistance)(o, shop) : null,
                    shopRadiusMeters: (0, yard_service_1.yardShopRadius)(shop),
                };
            }),
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] GET /yard/mine упал');
        res.status(500).json({ error: 'Не удалось получить кабинет', details: String(err?.message ?? err) });
    }
});
const httpUrl = zod_1.z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Ссылка должна начинаться с http:// или https://')
    .nullable()
    .optional();
const mineSettingsSchema = zod_1.z.object({
    phone: zod_1.z.string().min(1),
    radiusMeters: zod_1.z.number().refine((v) => yard_service_1.YARD_RADIUS_OPTIONS.includes(v), `Радиус: ${yard_service_1.YARD_RADIUS_OPTIONS.join(', ')} м`).optional(),
    bannerUrl: httpUrl,
    videoUrl: httpUrl,
    tickerText: zod_1.z.string().trim().max(300).nullable().optional(),
});
/**
 * Настройки магазина в кабинете: радиус (200 / 300 / 500 / 1000 м), баннер,
 * видео и бегущая строка. Только владелец (по телефону) и только после
 * одобрения. Меняется лишь то, что прислали; '' или null очищают баннер/видео/
 * строку (радиус очистить нельзя — он всегда один из четырёх).
 */
exports.yardRouter.post('/yard/mine/settings', async (req, res) => {
    const parsed = mineSettingsSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(parsed.data.phone);
    if (!normalizedPhone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    const { phone: _phone, ...fields } = parsed.data;
    if (Object.values(fields).every((v) => v === undefined))
        return res.status(400).json({ error: 'Нет полей для изменения' });
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { phone: normalizedPhone } });
        if (!shop)
            return res.status(404).json({ error: 'Заявка ещё не одобрена — настройки недоступны' });
        const blank = (v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim());
        const data = {};
        if (fields.radiusMeters !== undefined)
            data.radiusMeters = fields.radiusMeters;
        for (const k of ['bannerUrl', 'videoUrl', 'tickerText']) {
            const v = blank(fields[k]);
            if (v !== undefined)
                data[k] = v;
        }
        const updated = await prisma_1.prisma.yardShop.update({ where: { id: shop.id }, data });
        res.json({
            id: updated.id,
            radiusMeters: (0, yard_service_1.yardShopRadius)(updated),
            bannerUrl: updated.bannerUrl ?? null,
            videoUrl: updated.videoUrl ?? null,
            tickerText: updated.tickerText ?? null,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/mine/settings упал');
        res.status(500).json({ error: 'Не удалось сохранить настройки', details: String(err?.message ?? err) });
    }
});
const mineItemSchema = zod_1.z.object({
    phone: zod_1.z.string().min(1),
    id: zod_1.z.string().optional(),
    name: zod_1.z.string().min(1),
    price: zod_1.z.number().nonnegative(),
    stock: zod_1.z.number().int().nonnegative(),
    photo: zod_1.z.string().url().optional().nullable(),
    active: zod_1.z.boolean().optional().default(true),
    // Категория — свободная строка, фиксированного списка нет. Не передали
    // (undefined) — при правке старое значение остаётся; пустая строка/null — сброс.
    category: zod_1.z.string().max(100).optional().nullable(),
});
/**
 * Добавить/поправить одну позицию полки — только владелец (по телефону),
 * и только если его YardShop уже существует (а значит, заявка одобрена).
 * До одобрения товары грузить нельзя — 404 по тому же принципу, что и у
 * курьера до одобрения заявки.
 */
exports.yardRouter.post('/yard/mine/items', async (req, res) => {
    const parsed = mineItemSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    const normalizedPhone = (0, shop_routes_1.normalizePhone)(parsed.data.phone);
    if (!normalizedPhone)
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    try {
        const shop = await prisma_1.prisma.yardShop.findUnique({ where: { phone: normalizedPhone } });
        if (!shop)
            return res.status(404).json({ error: 'Заявка ещё не одобрена — товары грузить нельзя' });
        const itemData = {
            name: parsed.data.name,
            price: parsed.data.price,
            stock: parsed.data.stock,
            photo: parsed.data.photo ?? null,
            active: parsed.data.active,
        };
        const categoryProvided = parsed.data.category !== undefined;
        const category = (parsed.data.category ?? '').trim() || null;
        if (parsed.data.id) {
            const existing = await prisma_1.prisma.yardItem.findUnique({ where: { id: parsed.data.id } });
            if (!existing || existing.shopId !== shop.id)
                return res.status(404).json({ error: 'Товар не найден на вашей полке' });
            const updated = await prisma_1.prisma.yardItem.update({
                where: { id: parsed.data.id },
                data: { ...itemData, ...(categoryProvided ? { category } : {}) },
            });
            return res.json(updated);
        }
        const created = await prisma_1.prisma.yardItem.create({ data: { ...itemData, category, shopId: shop.id } });
        res.status(201).json(created);
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Yard] POST /yard/mine/items упал');
        res.status(500).json({ error: 'Не удалось сохранить товар', details: String(err?.message ?? err) });
    }
});
const paymentSchema = zod_1.z.object({ phone: zod_1.z.string().min(1), ok: zod_1.z.boolean() });
async function requireYardShopOwner(orderId, phone) {
    const order = await prisma_1.prisma.yardOrder.findUnique({ where: { id: orderId }, include: { shop: true } });
    if (!order)
        return { error: 'Заказ не найден', status: 404 };
    const normalized = (0, shop_routes_1.normalizePhone)(phone);
    if (!normalized || normalized !== order.shop.phone) {
        return { error: 'Только продавец может выполнить это действие', status: 403 };
    }
    return { order };
}
/** «Оплата есть/нет» — только продавец своего заказа. Полка списывается ТОЛЬКО по «Оплата есть». */
exports.yardRouter.post('/yard/orders/:id/payment', async (req, res) => {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
        if ('error' in check)
            return res.status(check.status).json({ error: check.error });
        const order = await (0, yard_service_1.yardApplyPayment)(req.params.id, parsed.data.ok);
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders/:id/payment упал');
        res.status(500).json({ error: 'Не удалось отметить оплату', details: String(err?.message ?? err) });
    }
});
const phoneOnlySchema = zod_1.z.object({ phone: zod_1.z.string().min(1) });
/**
 * «Оплачено» — кнопка продавца в чате и в заказе (приложение зовёт именно этот путь; /payment
 * остаётся для прежнего вызова с ok). Повторное нажатие — не ошибка. Покупателю уходит
 * «✅ Оплачено» в чат магазина и пуш: зелёный блок «Оплачено, ожидайте 15–25 минут» строится по нему.
 */
exports.yardRouter.post('/yard/orders/:id/paid', async (req, res) => {
    const parsed = zod_1.z.object({ phone: zod_1.z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
        if ('error' in check)
            return res.status(check.status).json({ error: check.error });
        const current = check.order;
        if (yard_service_1.YARD_PAID_OR_LATER.includes(current.status))
            return res.json({ id: current.id, status: current.status });
        const order = await (0, yard_service_1.yardApplyPayment)(req.params.id, true);
        try {
            await prisma_1.prisma.yardShopMessage.create({
                data: { shopId: current.shopId, buyerPhone: current.buyerPhone, from: 'shop', text: '✅ Оплачено' },
            });
        }
        catch (err) {
            logger_1.logger.warn({ err }, '[Yard] «✅ Оплачено» в чат не записалось');
        }
        const recipient = (0, shop_routes_1.normalizePhone)(current.buyerPhone) || current.buyerPhone;
        (0, push_service_1.sendPush)(recipient, {
            title: current.shop?.name || 'Магазин',
            body: 'Оплата подтверждена. Ожидайте 15–25 минут',
            data: { shopId: current.shopId, type: 'chat' },
        }).catch((err) => logger_1.logger.error({ err, recipient }, '[Yard] Пуш об оплате не ушёл'));
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders/:id/paid упал');
        res.status(500).json({ error: 'Не удалось отметить оплату', details: String(err?.message ?? err) });
    }
});
/** «Оплаты нет» — гасит заказ, остаток полки не трогает. Повтор — не ошибка. */
exports.yardRouter.post('/yard/orders/:id/reject', async (req, res) => {
    const parsed = zod_1.z.object({ phone: zod_1.z.string().min(1) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
        if ('error' in check)
            return res.status(check.status).json({ error: check.error });
        if (check.order.status === 'no_payment')
            return res.json({ id: check.order.id, status: check.order.status });
        const order = await (0, yard_service_1.yardApplyPayment)(req.params.id, false);
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders/:id/reject упал');
        res.status(500).json({ error: 'Не удалось отметить «оплаты нет»', details: String(err?.message ?? err) });
    }
});
/** «Принял» — только продавец, только из paid. Дальше телефон покупателя виден. */
exports.yardRouter.post('/yard/orders/:id/accept', async (req, res) => {
    const parsed = phoneOnlySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
        if ('error' in check)
            return res.status(check.status).json({ error: check.error });
        const order = await (0, yard_service_1.yardApplyAccept)(req.params.id);
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders/:id/accept упал');
        res.status(500).json({ error: 'Не удалось принять заказ', details: String(err?.message ?? err) });
    }
});
const closeSchema = zod_1.z.object({ phone: zod_1.z.string().min(1), status: zod_1.z.enum(['done', 'not_picked', 'out_of_stock']) });
/** Закрытие — done | not_picked | out_of_stock. Последние два возвращают остаток на полку. */
exports.yardRouter.post('/yard/orders/:id/close', async (req, res) => {
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const check = await requireYardShopOwner(req.params.id, parsed.data.phone);
        if ('error' in check)
            return res.status(check.status).json({ error: check.error });
        const order = await (0, yard_service_1.yardApplyClose)(req.params.id, parsed.data.status);
        res.json(order);
    }
    catch (err) {
        if (err instanceof yard_service_1.YardTransitionError)
            return res.status(err.status).json({ error: err.message });
        logger_1.logger.error({ err }, '[Yard] POST /yard/orders/:id/close упал');
        res.status(500).json({ error: 'Не удалось закрыть заказ', details: String(err?.message ?? err) });
    }
});
//# sourceMappingURL=yard.routes.js.map