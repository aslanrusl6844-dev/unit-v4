/**
 * Хранилище фото/видео My Market.
 *
 * ВИДЕО (video/mp4, video/webm) идут в Cloudflare R2 (бакет mymarket-videos), если заданы
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY и R2_PUBLIC_URL. Фото и всё остальное —
 * по-старому в Vercel Blob. Без R2 видео тоже идут в Blob, чтобы деплой ничего не сломал.
 * Старые ссылки на Blob, уже лежащие в базе, не трогаем — они продолжают открываться.
 *
 * Большие файлы (видео 10–50 МБ) нельзя пропустить через сервер: Vercel режет тело
 * запроса примерно на 4.5 МБ ДО нашего кода, и никакой multipart или лимит
 * express.json() это не обходит. Поэтому для них сервер выдаёт одноразовую подписанную
 * ссылку (presigned PUT), и браузер кладёт файл прямо в R2, минуя Vercel.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { put } from '@vercel/blob';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export type StorageKind = 'r2' | 'blob';

export class StorageUnavailableError extends Error {
  constructor(message: string, readonly storage: StorageKind | 'none', readonly cause?: unknown) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/** Заданы ли все пять R2_* переменных. */
export function isR2Configured(): boolean {
  const r = env.r2;
  return !!(r.accountId && r.accessKeyId && r.secretAccessKey && r.bucket && r.publicUrl);
}

export const isVideoType = (contentType: string) => contentType.startsWith('video/');

/** Куда пойдёт новая загрузка этого типа: видео — в R2 (если настроен), остальное — в Blob. */
export function activeStorage(contentType = 'video/mp4'): StorageKind | 'none' {
  if (isVideoType(contentType) && isR2Configured()) return 'r2';
  if (env.blobToken) return 'blob';
  return 'none';
}

let client: S3Client | null = null;
function r2Client(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.r2.accessKeyId, secretAccessKey: env.r2.secretAccessKey },
      // Без автоматических CRC32-заголовков: presigned PUT из браузера должен совпадать 1:1.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

/** Публичная ссылка на объект R2: `${R2_PUBLIC_URL}/${pathname}` — она и сохраняется в базу. */
export function r2PublicUrl(pathname: string): string {
  return `${env.r2.publicUrl}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
}

function safeName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
}

/** Путь в Vercel Blob — ровно как было: shop/<папка>/<время>-<имя>. */
export function buildMediaPath(folder: string, filename: string): string {
  return `shop/${folder}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/** Имя видео в бакете R2 (в корне бакета): <время>-<случайное>-<имя>.mp4. */
export function buildR2VideoKey(filename: string): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(filename)}`;
}

/** Сохранить файл (через сервер — только небольшие, до ~3 МБ). Возвращает публичную ссылку. */
export async function uploadPublicFile(folder: string, filename: string, buffer: Buffer, contentType: string): Promise<{ url: string; storage: StorageKind }> {
  const storage = activeStorage(contentType);
  if (storage === 'r2') {
    const pathname = buildR2VideoKey(filename);
    try {
      await r2Client().send(new PutObjectCommand({
        Bucket: env.r2.bucket,
        Key: pathname,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    } catch (err) {
      throw new StorageUnavailableError(`Cloudflare R2 недоступен: ${r2ErrorText(err)}`, 'r2', err);
    }
    const url = r2PublicUrl(pathname);
    logger.info({ storage: 'r2', pathname, bytes: buffer.length }, '[Media] файл сохранён в R2');
    return { url, storage: 'r2' };
  }
  if (storage === 'blob') {
    const pathname = buildMediaPath(folder, filename);
    try {
      const blob = await put(pathname, buffer, { access: 'public', contentType, token: env.blobToken });
      logger.info({ storage: 'blob', pathname, bytes: buffer.length }, '[Media] файл сохранён в Vercel Blob');
      return { url: blob.url, storage: 'blob' };
    } catch (err: any) {
      throw new StorageUnavailableError(`Vercel Blob недоступен: ${String(err?.message ?? err)}`, 'blob', err);
    }
  }
  throw new StorageUnavailableError('Хранилище не настроено: задайте R2_* или BLOB_READ_WRITE_TOKEN', 'none');
}

/**
 * Одноразовая ссылка для загрузки прямо из браузера в R2 (действует 10 минут).
 * Браузер делает PUT на uploadUrl с тем же Content-Type — файл в Vercel не попадает.
 */
export async function presignR2Upload(filename: string, contentType: string): Promise<{ uploadUrl: string; url: string; expiresIn: number }> {
  if (!isR2Configured()) throw new StorageUnavailableError('R2 не настроен', 'none');
  const pathname = buildR2VideoKey(filename);
  const expiresIn = 600;
  try {
    const uploadUrl = await getSignedUrl(
      r2Client(),
      new PutObjectCommand({ Bucket: env.r2.bucket, Key: pathname, ContentType: contentType }),
      { expiresIn },
    );
    logger.info({ storage: 'r2', pathname, contentType }, '[Media] выдана ссылка для прямой загрузки в R2');
    return { uploadUrl, url: r2PublicUrl(pathname), expiresIn };
  } catch (err) {
    throw new StorageUnavailableError(`Не удалось подготовить загрузку в R2: ${r2ErrorText(err)}`, 'r2', err);
  }
}

/** Понятный текст ошибки S3/R2 без технического мусора. */
function r2ErrorText(err: any): string {
  const name = err?.name || err?.Code || '';
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') return 'неверные R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY';
  if (name === 'NoSuchBucket') return `бакет «${env.r2.bucket}» не найден (проверьте R2_BUCKET_NAME)`;
  if (name === 'AccessDenied') return 'нет доступа — у ключа R2 должно быть право Object Read & Write на этот бакет';
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT') return 'нет связи с Cloudflare R2 (проверьте R2_ACCOUNT_ID)';
  return String(err?.message ?? err);
}
