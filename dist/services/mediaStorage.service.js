"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHUNK_PREFIX = exports.isVideoType = exports.StorageUnavailableError = void 0;
exports.isR2Configured = isR2Configured;
exports.activeStorage = activeStorage;
exports.r2ListKeys = r2ListKeys;
exports.r2PublicUrl = r2PublicUrl;
exports.buildMediaPath = buildMediaPath;
exports.buildR2VideoKey = buildR2VideoKey;
exports.uploadPublicFile = uploadPublicFile;
exports.presignR2Upload = presignR2Upload;
exports.r2PutChunk = r2PutChunk;
exports.r2CompleteChunks = r2CompleteChunks;
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
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const blob_1 = require("@vercel/blob");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
class StorageUnavailableError extends Error {
    storage;
    cause;
    constructor(message, storage, cause) {
        super(message);
        this.storage = storage;
        this.cause = cause;
        this.name = 'StorageUnavailableError';
    }
}
exports.StorageUnavailableError = StorageUnavailableError;
/** Заданы ли все пять R2_* переменных. */
function isR2Configured() {
    const r = env_1.env.r2;
    return !!(r.accountId && r.accessKeyId && r.secretAccessKey && r.bucket && r.publicUrl);
}
const isVideoType = (contentType) => contentType.startsWith('video/');
exports.isVideoType = isVideoType;
/** Куда пойдёт новая загрузка этого типа: видео — в R2 (если настроен), остальное — в Blob. */
function activeStorage(contentType = 'video/mp4') {
    if ((0, exports.isVideoType)(contentType) && isR2Configured())
        return 'r2';
    if (env_1.env.blobToken)
        return 'blob';
    return 'none';
}
let client = null;
function r2Client() {
    if (!client) {
        client = new client_s3_1.S3Client({
            region: 'auto',
            endpoint: `https://${env_1.env.r2.accountId}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: env_1.env.r2.accessKeyId, secretAccessKey: env_1.env.r2.secretAccessKey },
            // Без автоматических CRC32-заголовков: presigned PUT из браузера должен совпадать 1:1.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });
    }
    return client;
}
/** Ключи объектов R2 по префиксу (до 1000) — например, файлы записи эфира. */
async function r2ListKeys(prefix) {
    if (!isR2Configured())
        return [];
    const r = await r2Client().send(new client_s3_1.ListObjectsV2Command({ Bucket: env_1.env.r2.bucket, Prefix: prefix, MaxKeys: 1000 }));
    return (r.Contents ?? []).map((o) => o.Key ?? '').filter(Boolean);
}
/** Публичная ссылка на объект R2: `${R2_PUBLIC_URL}/${pathname}` — она и сохраняется в базу. */
function r2PublicUrl(pathname) {
    return `${env_1.env.r2.publicUrl}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
}
function safeName(filename) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
}
/** Путь в Vercel Blob — ровно как было: shop/<папка>/<время>-<имя>. */
function buildMediaPath(folder, filename) {
    return `shop/${folder}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}
/** Имя видео в бакете R2 (в корне бакета): <время>-<случайное>-<имя>.mp4. */
function buildR2VideoKey(filename) {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(filename)}`;
}
/** Сохранить файл (через сервер — только небольшие, до ~3 МБ). Возвращает публичную ссылку. */
async function uploadPublicFile(folder, filename, buffer, contentType) {
    const storage = activeStorage(contentType);
    if (storage === 'r2') {
        const pathname = buildR2VideoKey(filename);
        try {
            await r2Client().send(new client_s3_1.PutObjectCommand({
                Bucket: env_1.env.r2.bucket,
                Key: pathname,
                Body: buffer,
                ContentType: contentType,
                CacheControl: 'public, max-age=31536000, immutable',
            }));
        }
        catch (err) {
            throw new StorageUnavailableError(`Cloudflare R2 недоступен: ${r2ErrorText(err)}`, 'r2', err);
        }
        const url = r2PublicUrl(pathname);
        logger_1.logger.info({ storage: 'r2', pathname, bytes: buffer.length }, '[Media] файл сохранён в R2');
        return { url, storage: 'r2' };
    }
    if (storage === 'blob') {
        const pathname = buildMediaPath(folder, filename);
        try {
            const blob = await (0, blob_1.put)(pathname, buffer, { access: 'public', contentType, token: env_1.env.blobToken });
            logger_1.logger.info({ storage: 'blob', pathname, bytes: buffer.length }, '[Media] файл сохранён в Vercel Blob');
            return { url: blob.url, storage: 'blob' };
        }
        catch (err) {
            throw new StorageUnavailableError(`Vercel Blob недоступен: ${String(err?.message ?? err)}`, 'blob', err);
        }
    }
    throw new StorageUnavailableError('Хранилище не настроено: задайте R2_* или BLOB_READ_WRITE_TOKEN', 'none');
}
/**
 * Одноразовая ссылка для загрузки прямо из браузера в R2 (действует 10 минут).
 * Браузер делает PUT на uploadUrl с тем же Content-Type — файл в Vercel не попадает.
 */
async function presignR2Upload(filename, contentType) {
    if (!isR2Configured())
        throw new StorageUnavailableError('R2 не настроен', 'none');
    const pathname = buildR2VideoKey(filename);
    const expiresIn = 600;
    try {
        const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(r2Client(), new client_s3_1.PutObjectCommand({ Bucket: env_1.env.r2.bucket, Key: pathname, ContentType: contentType }), { expiresIn });
        logger_1.logger.info({ storage: 'r2', pathname, contentType }, '[Media] выдана ссылка для прямой загрузки в R2');
        return { uploadUrl, url: r2PublicUrl(pathname), expiresIn };
    }
    catch (err) {
        throw new StorageUnavailableError(`Не удалось подготовить загрузку в R2: ${r2ErrorText(err)}`, 'r2', err);
    }
}
/** Понятный текст ошибки S3/R2 без технического мусора. */
function r2ErrorText(err) {
    const name = err?.name || err?.Code || '';
    if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch')
        return 'неверные R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY';
    if (name === 'NoSuchBucket')
        return `бакет «${env_1.env.r2.bucket}» не найден (проверьте R2_BUCKET_NAME)`;
    if (name === 'AccessDenied')
        return 'нет доступа — у ключа R2 должно быть право Object Read & Write на этот бакет';
    if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT')
        return 'нет связи с Cloudflare R2 (проверьте R2_ACCOUNT_ID)';
    return String(err?.message ?? err);
}
// ---------------------------------------------------------------------------
// Загрузка видео кусками через наш сервер (без прямого соединения браузер → Cloudflare).
// Браузер шлёт куски по ≤4 МБ (предел Vercel на запрос); сервер кладёт каждый во временный
// объект R2 tmp-upload/<id>/<n>, в конце склеивает в один файл и временные удаляет.
// Если соединение браузера с Cloudflare рвётся на больших файлах — так видео всё равно доходит,
// а при обрыве повторяется только один кусок.
// ---------------------------------------------------------------------------
exports.CHUNK_PREFIX = 'tmp-upload';
const chunkKey = (uploadId, index) => `${exports.CHUNK_PREFIX}/${uploadId}/${String(index).padStart(4, '0')}`;
async function r2PutChunk(uploadId, index, body) {
    if (!isR2Configured())
        throw new StorageUnavailableError('R2 не настроен', 'none');
    try {
        await r2Client().send(new client_s3_1.PutObjectCommand({ Bucket: env_1.env.r2.bucket, Key: chunkKey(uploadId, index), Body: body, ContentType: 'application/octet-stream' }));
    }
    catch (err) {
        throw new StorageUnavailableError(`Cloudflare R2 недоступен: ${r2ErrorText(err)}`, 'r2', err);
    }
}
async function readBody(body) {
    if (!body)
        return Buffer.alloc(0);
    if (typeof body.transformToByteArray === 'function')
        return Buffer.from(await body.transformToByteArray());
    if (Buffer.isBuffer(body))
        return body;
    const parts = [];
    for await (const c of body)
        parts.push(Buffer.from(c));
    return Buffer.concat(parts);
}
/** Склеить куски 0..total-1 в видео, сохранить в R2 и удалить временные куски. */
async function r2CompleteChunks(uploadId, total, filename, contentType, maxBytes) {
    if (!isR2Configured())
        throw new StorageUnavailableError('R2 не настроен', 'none');
    const keys = Array.from({ length: total }, (_, i) => chunkKey(uploadId, i));
    const parts = [];
    let bytes = 0;
    try {
        for (const Key of keys) {
            const r = await r2Client().send(new client_s3_1.GetObjectCommand({ Bucket: env_1.env.r2.bucket, Key }));
            const buf = await readBody(r.Body);
            bytes += buf.length;
            if (bytes > maxBytes)
                throw new Error('файл больше допустимого');
            parts.push(buf);
        }
    }
    catch (err) {
        if (err?.name === 'NoSuchKey')
            throw new StorageUnavailableError('Не все части видео дошли до сервера — загрузите ещё раз', 'r2', err);
        if (err instanceof Error && err.message === 'файл больше допустимого')
            throw new StorageUnavailableError('Видео больше допустимого размера', 'r2', err);
        throw new StorageUnavailableError(`Cloudflare R2 недоступен: ${r2ErrorText(err)}`, 'r2', err);
    }
    const pathname = buildR2VideoKey(filename);
    try {
        await r2Client().send(new client_s3_1.PutObjectCommand({
            Bucket: env_1.env.r2.bucket, Key: pathname, Body: Buffer.concat(parts), ContentType: contentType,
            CacheControl: 'public, max-age=31536000, immutable',
        }));
    }
    catch (err) {
        throw new StorageUnavailableError(`Cloudflare R2 недоступен: ${r2ErrorText(err)}`, 'r2', err);
    }
    await r2Client().send(new client_s3_1.DeleteObjectsCommand({ Bucket: env_1.env.r2.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }))
        .catch((err) => logger_1.logger.warn({ err: String(err?.message ?? err) }, '[Media] временные куски не удалились'));
    logger_1.logger.info({ storage: 'r2', pathname, bytes, chunks: total }, '[Media] видео собрано из кусков и сохранено в R2');
    return { url: r2PublicUrl(pathname), bytes };
}
//# sourceMappingURL=mediaStorage.service.js.map