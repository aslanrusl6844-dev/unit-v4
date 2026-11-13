import { Router } from 'express';
import { z } from 'zod';
import {
  activeStorage, isR2Configured, isVideoType, presignR2Upload, uploadPublicFile, StorageUnavailableError,
} from '../services/mediaStorage.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { generateWaybillPdf, WaybillAddressError, WaybillOrderItem } from '../services/waybill.service';

export const shopMediaRouter = Router();

/**
 * Накладная-наклейка (75×120 мм) для заказа My Market — админский путь,
 * без x-app-key (см. общий комментарий про /api/shop/admin выше в этом
 * файле — тот же порядок подключения роутов в expressApp.ts гарантирует,
 * что этот путь не попадает под x-app-key основного /api/shop).
 */
shopMediaRouter.get('/orders/:id/waybill', async (req, res) => {
  try {
    const order = await prisma.shopOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });

    let items: WaybillOrderItem[] = [];
    try {
      items = (JSON.parse(order.items) as Array<{ sku: string; name: string; quantity: number }>)
        .map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity }));
    } catch {
      items = [];
    }

    const pdfBuffer = await generateWaybillPdf({
      number: order.number,
      customerName: order.customerName,
      phone: order.phone,
      city: order.city,
      street: order.street,
      house: order.house,
      apartment: order.apartment,
      entrance: order.entrance,
      floor: order.floor,
      intercom: order.intercom,
      items,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="waybill-${order.number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: any) {
    if (err instanceof WaybillAddressError) {
      return res.status(400).json({ error: 'не заполнен адрес' });
    }
    logger.error({ err }, '[Shop Media] Ошибка генерации накладной');
    res.status(500).json({ error: 'Не удалось сформировать накладную', details: String(err?.message ?? err) });
  }
});

/**
 * Загрузка фото/видео My Market — ТОЛЬКО из админки (не защищено x-app-key
 * приложения). Роут подключён в expressApp.ts ПОД ПУТЁМ /api/shop/admin и РАНЬШЕ
 * основного /api/shop (у которого общий x-app-key) — поэтому та проверка сюда не попадает.
 *
 * ВИДЕО (MP4/WEBM) — в Cloudflare R2, бакет mymarket-videos:
 *  1. POST /upload-url — сервер выдаёт одноразовую ссылку, браузер кладёт видео (до 100 МБ)
 *     прямо в R2. Через Vercel файл не идёт, поэтому его предел ~4.5 МБ не мешает
 *     (этот предел Vercel ставит ДО нашего кода — multipart или express.json() его не обходят).
 *     В базу сохраняется публичная ссылка `${R2_PUBLIC_URL}/<имя-файла>.mp4`.
 * ФОТО и всё остальное — без изменений:
 *  2. POST /upload — файл в base64 через сервер в Vercel Blob (до ~3 МБ). Маленькое видео,
 *     присланное сюда, при настроенном R2 тоже уходит в R2.
 */

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Через сервер (base64): 2.5 МБ файла → ~3.3 МБ текста — укладывается в express.json() 4mb
// и держится ниже предела Vercel (~4.5 МБ).
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

/**
 * Баннеры главной (4 слота): purpose='banner' разрешает ещё GIF и короткие видео MP4/WEBM.
 * Через сервер — 3 000 000 байт (в base64 ~4.0 МБ, как и у express.json()).
 */
export const BANNER_ALLOWED_TYPES = [...ALLOWED_IMAGE_TYPES, 'image/gif', 'video/mp4', 'video/webm'];
export const MAX_BANNER_BYTES = 3_000_000;
/** Видео товара и витрины (purpose='video'): только MP4/WEBM. */
export const VIDEO_ALLOWED_TYPES = ['video/mp4', 'video/webm'];

/** Предел видео при прямой загрузке в R2 (мимо Vercel). */
export const DIRECT_MAX_VIDEO_BYTES = 100 * 1024 * 1024;

type Purpose = 'image' | 'banner' | 'video';

function rulesFor(purpose: Purpose) {
  const isVideo = purpose === 'video';
  const isBanner = purpose === 'banner' || isVideo;
  return {
    folder: isVideo ? 'video' : isBanner ? 'banner' : 'image',
    allowedTypes: isVideo ? VIDEO_ALLOWED_TYPES : isBanner ? BANNER_ALLOWED_TYPES : ALLOWED_IMAGE_TYPES,
    viaServerMax: isBanner ? MAX_BANNER_BYTES : MAX_IMAGE_BYTES,
    formatError: isVideo
      ? 'Формат не поддерживается. Нужен MP4 или WEBM'
      : isBanner
      ? 'Формат не поддерживается. Нужен JPEG, PNG, WEBP, GIF, MP4 или WEBM'
      : `Недопустимый формат файла. Разрешено: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
  };
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

/** Куда сейчас идут видео и фото и какие пределы — для проверки настройки. */
shopMediaRouter.get('/upload-info', (_req, res) => {
  const r2 = isR2Configured();
  res.json({
    videoStorage: activeStorage('video/mp4'),
    imageStorage: activeStorage('image/jpeg'),
    directVideo: r2,
    maxVideoBytes: r2 ? DIRECT_MAX_VIDEO_BYTES : MAX_BANNER_BYTES,
    maxImageBytes: MAX_IMAGE_BYTES,
  });
});

const uploadUrlSchema = z.object({
  purpose: z.enum(['image', 'banner', 'video']).optional(),
  filename: z.string().min(1).max(300),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
});

/**
 * ЗАГРУЗКА ВИДЕО: ссылка для прямой загрузки в R2. Ответ: { uploadUrl, url, method: 'PUT', headers }.
 * Браузер делает PUT на uploadUrl с телом-файлом и заголовком Content-Type, потом
 * сохраняет url (публичная ссылка R2) в товар/витрину/баннер как раньше.
 * Только видео (MP4/WEBM), до 100 МБ. 501 { reason: 'no_r2' } — R2 не настроен:
 * админка грузит по-старому через /upload.
 */
shopMediaRouter.post('/upload-url', async (req, res) => {
  const parsed = uploadUrlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные загрузки', details: parsed.error.flatten() });
  const { filename, contentType, size } = parsed.data;
  const rules = rulesFor(parsed.data.purpose ?? 'image');
  if (!isR2Configured()) {
    return res.status(501).json({ error: 'Cloudflare R2 не настроен', reason: 'no_r2', details: 'Загрузка пойдёт по-старому через сервер (до ~3 МБ).' });
  }
  if (!rules.allowedTypes.includes(contentType)) return res.status(400).json({ error: rules.formatError });
  if (!isVideoType(contentType)) {
    return res.status(400).json({ error: 'Прямая загрузка — только для видео (MP4/WEBM). Фото загружаются как раньше.', reason: 'not_video' });
  }
  if (size > DIRECT_MAX_VIDEO_BYTES) {
    return res.status(413).json({ error: `Файл слишком большой: ${mb(size)} МБ, максимум ${mb(DIRECT_MAX_VIDEO_BYTES)} МБ` });
  }
  try {
    const signed = await presignR2Upload(filename, contentType);
    res.json({ ...signed, method: 'PUT', headers: { 'Content-Type': contentType }, storage: 'r2' });
  } catch (err: any) {
    logger.error({ err }, '[Shop Media] не удалось выдать ссылку для загрузки в R2');
    res.status(503).json({ error: err instanceof StorageUnavailableError ? err.message : 'Хранилище недоступно', details: 'Попробуйте позже или загрузите файл поменьше.' });
  }
});

const uploadSchema = z.object({
  kind: z.literal('image'),
  purpose: z.enum(['banner', 'video']).optional(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string().min(1),
});

/** Старый путь: файл в base64 через сервер (до ~3 МБ). Фото — в Blob; видео — в R2, если он настроен. */
shopMediaRouter.post('/upload', async (req, res) => {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Неверные данные загрузки', details: parsed.error.flatten() });
  }
  const { filename, contentType, dataBase64 } = parsed.data;
  const rules = rulesFor(parsed.data.purpose ?? 'image');
  const isBanner = parsed.data.purpose === 'banner' || parsed.data.purpose === 'video';

  // Проверяем ДО декодирования: файл всё равно некуда сохранить.
  if (activeStorage(contentType) === 'none') {
    return res.status(501).json({ error: 'добавьте Blob', details: 'Не заданы ни R2_* (Cloudflare R2), ни BLOB_READ_WRITE_TOKEN — загрузка файлом недоступна, используйте поле URL.' });
  }

  if (!rules.allowedTypes.includes(contentType)) {
    return res.status(400).json({ error: rules.formatError });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch (err: any) {
    return res.status(400).json({ error: 'Не удалось декодировать файл', details: String(err?.message ?? err) });
  }

  if (buffer.length > rules.viaServerMax) {
    return res.status(413).json({
      error: isBanner
        ? `Файл слишком большой: ${(buffer.length / 1e6).toFixed(1)} МБ, максимум ${rules.viaServerMax / 1e6} МБ`
        : `Файл слишком большой: ${mb(buffer.length)} МБ, максимум ${mb(rules.viaServerMax)} МБ`,
      details: isR2Configured() && isVideoType(contentType)
        ? 'Видео загружаются напрямую в Cloudflare R2 (до 100 МБ) — обновите страницу админки.'
        : 'Через сервер больше не пройдёт (предел Vercel ~4.5 МБ).',
    });
  }

  try {
    const { url } = await uploadPublicFile(rules.folder, filename, buffer, contentType);
    res.json({ url });
  } catch (err: any) {
    logger.error({ err }, '[Shop Media] Ошибка загрузки файла');
    res.status(500).json({
      error: 'Не удалось загрузить файл в хранилище',
      details: String(err?.message ?? err),
    });
  }
});
