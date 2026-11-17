"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SLIDES_ORDER = exports.cityImagesAdminRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../db/prisma");
const logger_1 = require("../utils/logger");
const cities_1 = require("../config/cities");
/**
 * Админка «Картинки городов»: до 10 картинок (слайдов) на город.
 * Файл админка загружает в тот же Blob, что и фото товаров
 * (POST /api/shop/admin/upload), сюда приходит готовая https-ссылка.
 * Вход — Basic admin (глобальный adminAuthMiddleware на /api/*).
 */
exports.cityImagesAdminRouter = (0, express_1.Router)();
const imageUrlSchema = zod_1.z.object({
    imageUrl: zod_1.z.string().trim().max(2000).refine((u) => /^https:\/\/\S+$/i.test(u), 'Картинка должна быть ссылкой https://'),
});
exports.SLIDES_ORDER = [{ position: 'asc' }, { createdAt: 'asc' }];
function fail(res, err, what) {
    logger_1.logger.error({ err }, `[CityImages] ${what}`);
    res.status(500).json({ error: what, details: String(err?.message ?? err) });
}
const toImages = (rows) => rows.map((r) => ({ id: r.id, url: r.imageUrl }));
exports.cityImagesAdminRouter.get('/', async (_req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const rows = await prisma_1.prisma.cityImageSlide.findMany({ orderBy: exports.SLIDES_ORDER });
        res.json(cities_1.CITY_IMAGE_CITIES.map((city) => {
            const images = toImages(rows.filter((r) => r.city === city));
            return { city, images, imageUrl: images[0]?.url ?? null, max: cities_1.MAX_CITY_IMAGES };
        }));
    }
    catch (err) {
        fail(res, err, 'Не удалось получить картинки городов');
    }
});
/** Добавить ещё одну картинку городу (не больше MAX_CITY_IMAGES). */
exports.cityImagesAdminRouter.post('/:city', async (req, res) => {
    const city = (0, cities_1.resolveCity)(req.params.city);
    if (!city)
        return res.status(404).json({ error: 'Такого города нет в списке' });
    const parsed = imageUrlSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
    try {
        const existing = await prisma_1.prisma.cityImageSlide.findMany({ where: { city }, orderBy: exports.SLIDES_ORDER });
        if (existing.length >= cities_1.MAX_CITY_IMAGES) {
            return res.status(400).json({ error: `Для города можно загрузить не больше ${cities_1.MAX_CITY_IMAGES} картинок` });
        }
        const position = existing.reduce((m, r) => Math.max(m, r.position), -1) + 1;
        const row = await prisma_1.prisma.cityImageSlide.create({ data: { city, imageUrl: parsed.data.imageUrl, position } });
        res.status(201).json({ city, images: toImages([...existing, row]), max: cities_1.MAX_CITY_IMAGES });
    }
    catch (err) {
        fail(res, err, 'Не удалось сохранить картинку города');
    }
});
/** Удалить одну картинку города (файл в Blob остаётся — как и у фото товаров). Нет такой — тоже ок. */
exports.cityImagesAdminRouter.delete('/:city/:id', async (req, res) => {
    const city = (0, cities_1.resolveCity)(req.params.city);
    if (!city)
        return res.status(404).json({ error: 'Такого города нет в списке' });
    try {
        await prisma_1.prisma.cityImageSlide.deleteMany({ where: { id: String(req.params.id), city } });
        const rows = await prisma_1.prisma.cityImageSlide.findMany({ where: { city }, orderBy: exports.SLIDES_ORDER });
        res.json({ ok: true, city, images: toImages(rows), max: cities_1.MAX_CITY_IMAGES });
    }
    catch (err) {
        fail(res, err, 'Не удалось удалить картинку города');
    }
});
//# sourceMappingURL=cityImages.routes.js.map