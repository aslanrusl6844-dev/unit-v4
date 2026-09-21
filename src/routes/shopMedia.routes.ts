import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { put } from '@vercel/blob';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const shopMediaRouter = Router();

/**
 * Загрузка фото/видео товара My Market — ТОЛЬКО из админки (не защищено
 * x-app-key приложения). Важно про порядок подключения роутов: этот роут
 * зарегистрирован в expressApp.ts ПОД ПУТЁМ /api/shop/admin, и подключён
 * РАНЬШЕ основного /api/shop (у которого есть общий x-app-key middleware
 * на весь путь) — поэтому запрос сюда не попадает под ту проверку.
 *
 * Файл приходит как base64 в теле JSON-запроса (не multipart/form-data —
 * так не нужна новая зависимость вроде multer, укладывается в уже
 * существующий express.json() подход всего проекта). Для этого пути
 * увеличен лимит тела запроса — видео до 50 МБ в base64 это ~67 МБ текста.
 */
shopMediaRouter.use(express.json({ limit: '80mb' }));

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 МБ
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 МБ

const uploadSchema = z.object({
  kind: z.enum(['image', 'video']),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  dataBase64: z.string().min(1),
});

shopMediaRouter.post('/upload', async (req, res) => {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Неверные данные загрузки', details: parsed.error.flatten() });
  }
  const { kind, filename, contentType, dataBase64 } = parsed.data;

  // Честно отказываем, если Blob не настроен — не пытаемся "как-то иначе"
  // сохранить файл, просто говорим прямо. Вставка URL при этом продолжает
  // работать (это отдельное, независимое от загрузки файлом поле на фронте).
  if (!env.blobToken) {
    return res.status(501).json({ error: 'добавьте Blob', details: 'BLOB_READ_WRITE_TOKEN не задан в переменных окружения — загрузка файлом недоступна, используйте поле URL.' });
  }

  const allowedTypes = kind === 'image' ? ALLOWED_IMAGE_TYPES : ALLOWED_VIDEO_TYPES;
  if (!allowedTypes.includes(contentType)) {
    return res.status(400).json({ error: `Недопустимый формат файла: ${contentType}. Разрешено: ${allowedTypes.join(', ')}` });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'Не удалось декодировать файл' });
  }

  const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (buffer.length > maxBytes) {
    return res.status(400).json({ error: `Файл слишком большой: ${(buffer.length / 1024 / 1024).toFixed(1)} МБ, максимум ${maxBytes / 1024 / 1024} МБ` });
  }

  try {
    const pathname = `shop/${kind}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
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
