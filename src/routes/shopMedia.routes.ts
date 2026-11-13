import express, { Router } from 'express';
import { z } from 'zod';
import {
  activeStorage, isR2Configured, isVideoType, presignR2Upload, uploadPublicFile, StorageUnavailableError,
  r2PutChunk, r2CompleteChunks,
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

/** Хост из «локальной» сети — такие адреса сервер не скачивает (защита от SSRF). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Тип видео по ответу сайта или по расширению в ссылке (некоторые CDN отдают octet-stream). */
function videoTypeOf(contentType: string | null, url: URL): string | null {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (VIDEO_ALLOWED_TYPES.includes(ct)) return ct;
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
    if (/\.mp4$/i.test(url.pathname)) return 'video/mp4';
    if (/\.webm$/i.test(url.pathname)) return 'video/webm';
  }
  return null;
}

const fromUrlSchema = z.object({ url: z.string().url().max(2000) });

/**
 * Видео по ссылке (перетащили видео с сайта в админку): сервер сам скачивает файл MP4/WEBM
 * (до 100 МБ) и кладёт к себе — в Cloudflare R2 (или в Blob, если R2 не настроен). Так видео
 * не пропадёт, если чужой сайт его уберёт. Ссылка на страницу (YouTube и т. п.), а не на файл —
 * понятный отказ: такое видео нужно скачать и перетащить файлом.
 */
shopMediaRouter.post('/upload-from-url', async (req, res) => {
  const parsed = fromUrlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Это не ссылка' });
  let url: URL;
  try { url = new URL(parsed.data.url); } catch { return res.status(400).json({ error: 'Это не ссылка' }); }
  if (!['http:', 'https:'].includes(url.protocol) || isPrivateHost(url.hostname)) {
    return res.status(400).json({ error: 'Такую ссылку скачать нельзя' });
  }
  if (activeStorage('video/mp4') === 'none') return res.status(501).json({ error: 'Хранилище для видео не настроено' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (MyMarket admin video import)' } });
    if (!r.ok || !r.body) return res.status(400).json({ error: `Сайт не отдал видео (HTTP ${r.status})`, details: 'Скачайте видео на компьютер и перетащите файл.' });
    const finalUrl = new URL(r.url || url.toString());
    const contentType = videoTypeOf(r.headers.get('content-type'), finalUrl);
    if (!contentType) {
      return res.status(400).json({
        error: 'По ссылке не файл видео, а страница сайта',
        reason: 'not_video_file',
        details: 'Так бывает с YouTube, Instagram, TikTok и т. п. Скачайте видео на компьютер (MP4) и перетащите файл.',
      });
    }
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > DIRECT_MAX_VIDEO_BYTES) {
      ctrl.abort();
      return res.status(413).json({ error: `Видео слишком большое: ${mb(declared)} МБ, максимум ${mb(DIRECT_MAX_VIDEO_BYTES)} МБ` });
    }
    // Читаем с ограничением: сайт мог не прислать размер.
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DIRECT_MAX_VIDEO_BYTES) {
        ctrl.abort();
        return res.status(413).json({ error: `Видео больше ${mb(DIRECT_MAX_VIDEO_BYTES)} МБ` });
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) return res.status(400).json({ error: 'Сайт отдал пустой файл' });
    const base = decodeURIComponent(finalUrl.pathname.split('/').pop() || '') || 'video';
    const filename = /\.(mp4|webm)$/i.test(base) ? base : `${base}.${contentType === 'video/webm' ? 'webm' : 'mp4'}`;
    const saved = await uploadPublicFile('video', filename, Buffer.concat(chunks), contentType);
    logger.info({ from: url.hostname, bytes: total, storage: saved.storage }, '[Shop Media] видео по ссылке сохранено');
    res.json({ url: saved.url, bytes: total, storage: saved.storage });
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    logger.warn({ err: String(err?.message ?? err), host: url.hostname }, '[Shop Media] видео по ссылке не скачалось');
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'Сайт отдаёт видео слишком долго' : 'Не удалось скачать видео с сайта',
      details: 'Скачайте видео на компьютер и перетащите файл.',
    });
  } finally {
    clearTimeout(timer);
  }
});

/** Размер куска: ниже предела Vercel на тело запроса (~4.5 МБ). */
export const VIDEO_CHUNK_BYTES = 4 * 1000 * 1000;
const UPLOAD_ID_RE = /^[a-z0-9-]{8,64}$/i;

/**
 * ЗАГРУЗКА ВИДЕО КУСКАМИ через сервер (основной путь для видео в админке):
 *   POST /video-chunk?uploadId=…&index=N  — тело: кусок файла (application/octet-stream, ≤4 МБ);
 *   POST /video-complete { uploadId, total, filename, contentType } → { url }.
 * Браузер не соединяется с Cloudflare напрямую, поэтому обрывы того соединения не мешают;
 * упавший кусок админка просто отправляет ещё раз.
 */
shopMediaRouter.post('/video-chunk', express.raw({ type: 'application/octet-stream', limit: '4400kb' }), async (req, res) => {
  const uploadId = String(req.query.uploadId ?? '');
  const index = Number(req.query.index);
  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(index) || index < 0 || index > Math.ceil(DIRECT_MAX_VIDEO_BYTES / VIDEO_CHUNK_BYTES)) {
    return res.status(400).json({ error: 'Неверный кусок загрузки' });
  }
  if (!isR2Configured()) return res.status(501).json({ error: 'Cloudflare R2 не настроен', reason: 'no_r2' });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Пустой кусок' });
  try {
    await r2PutChunk(uploadId, index, body);
    res.json({ ok: true, index, bytes: body.length });
  } catch (err: any) {
    logger.error({ err }, '[Shop Media] кусок видео не сохранился');
    res.status(500).json({ error: 'Не удалось сохранить часть видео', details: String(err?.message ?? err) });
  }
});

const completeSchema = z.object({
  uploadId: z.string().regex(UPLOAD_ID_RE),
  total: z.number().int().min(1).max(Math.ceil(DIRECT_MAX_VIDEO_BYTES / VIDEO_CHUNK_BYTES)),
  filename: z.string().min(1).max(300),
  contentType: z.string().min(1),
});

shopMediaRouter.post('/video-complete', async (req, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные загрузки', details: parsed.error.flatten() });
  const { uploadId, total, filename, contentType } = parsed.data;
  if (!VIDEO_ALLOWED_TYPES.includes(contentType)) return res.status(400).json({ error: 'Формат не поддерживается. Нужен MP4 или WEBM' });
  if (!isR2Configured()) return res.status(501).json({ error: 'Cloudflare R2 не настроен', reason: 'no_r2' });
  try {
    const r = await r2CompleteChunks(uploadId, total, filename, contentType, DIRECT_MAX_VIDEO_BYTES);
    res.json({ url: r.url, bytes: r.bytes, storage: 'r2' });
  } catch (err: any) {
    logger.error({ err }, '[Shop Media] видео не собралось из кусков');
    res.status(500).json({ error: err instanceof StorageUnavailableError ? err.message : 'Не удалось сохранить видео', details: String(err?.message ?? err) });
  }
});
