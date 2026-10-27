import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { CITY_IMAGE_CITIES, MAX_CITY_IMAGES, resolveCity } from '../config/cities';

/**
 * Админка «Картинки городов»: до 10 картинок (слайдов) на город.
 * Файл админка загружает в тот же Blob, что и фото товаров
 * (POST /api/shop/admin/upload), сюда приходит готовая https-ссылка.
 * Вход — Basic admin (глобальный adminAuthMiddleware на /api/*).
 */
export const cityImagesAdminRouter = Router();

const imageUrlSchema = z.object({
  imageUrl: z.string().trim().max(2000).refine((u) => /^https:\/\/\S+$/i.test(u), 'Картинка должна быть ссылкой https://'),
});

type Slide = { id: string; city: string; imageUrl: string; position: number };

export const SLIDES_ORDER = [{ position: 'asc' as const }, { createdAt: 'asc' as const }];

function fail(res: any, err: any, what: string) {
  logger.error({ err }, `[CityImages] ${what}`);
  res.status(500).json({ error: what, details: String(err?.message ?? err) });
}

const toImages = (rows: Slide[]) => rows.map((r) => ({ id: r.id, url: r.imageUrl }));

cityImagesAdminRouter.get('/', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const rows: Slide[] = await prisma.cityImageSlide.findMany({ orderBy: SLIDES_ORDER });
    res.json(CITY_IMAGE_CITIES.map((city) => {
      const images = toImages(rows.filter((r) => r.city === city));
      return { city, images, imageUrl: images[0]?.url ?? null, max: MAX_CITY_IMAGES };
    }));
  } catch (err: any) {
    fail(res, err, 'Не удалось получить картинки городов');
  }
});

/** Добавить ещё одну картинку городу (не больше MAX_CITY_IMAGES). */
cityImagesAdminRouter.post('/:city', async (req, res) => {
  const city = resolveCity(req.params.city);
  if (!city) return res.status(404).json({ error: 'Такого города нет в списке' });
  const parsed = imageUrlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const existing: Slide[] = await prisma.cityImageSlide.findMany({ where: { city }, orderBy: SLIDES_ORDER });
    if (existing.length >= MAX_CITY_IMAGES) {
      return res.status(400).json({ error: `Для города можно загрузить не больше ${MAX_CITY_IMAGES} картинок` });
    }
    const position = existing.reduce((m, r) => Math.max(m, r.position), -1) + 1;
    const row: Slide = await prisma.cityImageSlide.create({ data: { city, imageUrl: parsed.data.imageUrl, position } });
    res.status(201).json({ city, images: toImages([...existing, row]), max: MAX_CITY_IMAGES });
  } catch (err: any) {
    fail(res, err, 'Не удалось сохранить картинку города');
  }
});

/** Удалить одну картинку города (файл в Blob остаётся — как и у фото товаров). Нет такой — тоже ок. */
cityImagesAdminRouter.delete('/:city/:id', async (req, res) => {
  const city = resolveCity(req.params.city);
  if (!city) return res.status(404).json({ error: 'Такого города нет в списке' });
  try {
    await prisma.cityImageSlide.deleteMany({ where: { id: String(req.params.id), city } });
    const rows: Slide[] = await prisma.cityImageSlide.findMany({ where: { city }, orderBy: SLIDES_ORDER });
    res.json({ ok: true, city, images: toImages(rows), max: MAX_CITY_IMAGES });
  } catch (err: any) {
    fail(res, err, 'Не удалось удалить картинку города');
  }
});
