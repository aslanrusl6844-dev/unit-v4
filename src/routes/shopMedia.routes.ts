import { Router } from 'express';
import { z } from 'zod';
import { put } from '@vercel/blob';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const shopMediaRouter = Router();

/**
 * Загрузка фото товара My Market — ТОЛЬКО из админки (не защищено x-app-key
 * приложения). Важно про порядок подключения роутов: этот роут
 * зарегистрирован в expressApp.ts ПОД ПУТЁМ /api/shop/admin, и подключён
 * РАНЬШЕ основного /api/shop (у которого есть общий x-app-key middleware
 * на весь путь) — поэтому запрос сюда не попадает под ту проверку.
 *
 * ВИДЕО ФАЙЛОМ НЕ ПРИНИМАЕТСЯ — только ссылка (поле URL на фронте).
 * Причина: Vercel режет тело запроса на своей стороне примерно на 4.5 МБ,
 * независимо от любых наших настроек Express — видео такого размера
 * практически никогда не бывает, а честно показать "файл не поместится"
 * до отправки нельзя, поэтому проще и честнее вообще не предлагать этот
 * путь для видео.
 *
 * Фото — тоже ограничены не изначально заявленными 10 МБ, а куда меньшим
 * реальным пределом (см. MAX_IMAGE_BYTES ниже) — тоже из-за того же
 * ограничения Vercel на размер тела запроса (см. также глобальный лимит
 * express.json() в expressApp.ts, который должен быть согласован с этим
 * числом).
 */

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// 2.5 МБ исходного файла → в base64 это ~3.3 МБ текста — укладывается в
// глобальный лимит express.json() 4мб (см. expressApp.ts) с запасом на
// JSON-обёртку, и держится ниже жёсткого предела самого Vercel (~4.5 МБ).
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

const uploadSchema = z.object({
  kind: z.literal('image'),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string().min(1),
});

shopMediaRouter.post('/upload', async (req, res) => {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Неверные данные загрузки', details: parsed.error.flatten() });
  }
  const { filename, contentType, dataBase64 } = parsed.data;

  // Честно отказываем, если Blob не настроен — НЕ 500, конкретный текст,
  // как договорились. Проверяем ДО декодирования/обращения к Blob, чтобы
  // не тратить время на файл, который всё равно некуда сохранить.
  if (!env.blobToken) {
    return res.status(501).json({ error: 'добавьте Blob', details: 'BLOB_READ_WRITE_TOKEN не задан в переменных окружения — загрузка файлом недоступна, используйте поле URL.' });
  }

  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    return res.status(400).json({ error: `Недопустимый формат файла: ${contentType}. Разрешено: ${ALLOWED_IMAGE_TYPES.join(', ')}` });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch (err: any) {
    return res.status(400).json({ error: 'Не удалось декодировать файл', details: String(err?.message ?? err) });
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error: `Файл слишком большой: ${(buffer.length / 1024 / 1024).toFixed(1)} МБ, максимум ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)} МБ`,
      details: 'Ограничение ниже, чем изначально заявленные 10 МБ, из-за предела Vercel на размер тела запроса (~4.5 МБ) — большой файл в base64 в него не помещается.',
    });
  }

  try {
    const pathname = `shop/image/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType,
      token: env.blobToken,
    });
    res.json({ url: blob.url });
  } catch (err: any) {
    logger.error({ err }, '[Shop Media] Ошибка загрузки в Vercel Blob');
    res.status(500).json({ error: 'Не удалось загрузить файл в хранилище', details: String(err?.message ?? err) });
  }
});
