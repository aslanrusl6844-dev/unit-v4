import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { CITY_IMAGE_CITIES, resolveCity } from '../config/cities';

/**
 * Админка «Картинки городов»: список городов с картинками, загрузка/замена, удаление.
 * Саму картинку админка загружает в тот же Blob, что и фото товаров
 * (POST /api/shop/admin/upload), сюда приходит готовая https-ссылка.
 * Вход — Basic admin (глобальный adminAuthMiddleware на /api/*).
 */
export const cityImagesAdminRouter = Router();

const imageUrlSchema = z.object({
  imageUrl: z.string().trim().max(2000).refine((u) => /^https:\/\/\S+$/i.test(u), 'Картинка должна быть ссылкой https://'),
});

function fail(res: any, err: any, what: string) {
  logger.error({ err }, `[CityImages] ${what}`);
  res.status(500).json({ error: what, details: String(err?.message ?? err) });
}

cityImagesAdminRouter.get('/', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const rows: Array<{ city: string; imageUrl: string; updatedAt?: Date }> = await prisma.cityImage.findMany();
    const byCity = new Map(rows.map((r) => [r.city, r]));
    res.json(CITY_IMAGE_CITIES.map((city) => ({ city, imageUrl: byCity.get(city)?.imageUrl ?? null, updatedAt: byCity.get(city)?.updatedAt ?? null })));
  } catch (err: any) {
    fail(res, err, 'Не удалось получить картинки городов');
  }
});

/** Загрузить или заменить картинку города. Только города из списка. */
cityImagesAdminRouter.put('/:city', async (req, res) => {
  const city = resolveCity(req.params.city);
  if (!city) return res.status(404).json({ error: 'Такого города нет в списке' });
  const parsed = imageUrlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  try {
    const row = await prisma.cityImage.upsert({
      where: { city },
      update: { imageUrl: parsed.data.imageUrl },
      create: { city, imageUrl: parsed.data.imageUrl },
    });
    res.json({ city, imageUrl: row.imageUrl });
  } catch (err: any) {
    fail(res, err, 'Не удалось сохранить картинку города');
  }
});

/** Удалить картинку города (сам файл в Blob остаётся — как и у фото товаров). Нет картинки — тоже ок. */
cityImagesAdminRouter.delete('/:city', async (req, res) => {
  const city = resolveCity(req.params.city);
  if (!city) return res.status(404).json({ error: 'Такого города нет в списке' });
  try {
    await prisma.cityImage.deleteMany({ where: { city } });
    res.json({ ok: true, city, imageUrl: null });
  } catch (err: any) {
    fail(res, err, 'Не удалось удалить картинку города');
  }
});
