export type StorageKind = 'r2' | 'blob';
export declare class StorageUnavailableError extends Error {
    readonly storage: StorageKind | 'none';
    readonly cause?: unknown | undefined;
    constructor(message: string, storage: StorageKind | 'none', cause?: unknown | undefined);
}
/** Заданы ли все пять R2_* переменных. */
export declare function isR2Configured(): boolean;
export declare const isVideoType: (contentType: string) => boolean;
/** Куда пойдёт новая загрузка этого типа: видео — в R2 (если настроен), остальное — в Blob. */
export declare function activeStorage(contentType?: string): StorageKind | 'none';
/** Ключи объектов R2 по префиксу (до 1000) — например, файлы записи эфира. */
export declare function r2ListKeys(prefix: string): Promise<string[]>;
/** Публичная ссылка на объект R2: `${R2_PUBLIC_URL}/${pathname}` — она и сохраняется в базу. */
export declare function r2PublicUrl(pathname: string): string;
/** Путь в Vercel Blob — ровно как было: shop/<папка>/<время>-<имя>. */
export declare function buildMediaPath(folder: string, filename: string): string;
/** Имя видео в бакете R2 (в корне бакета): <время>-<случайное>-<имя>.mp4. */
export declare function buildR2VideoKey(filename: string): string;
/** Сохранить файл (через сервер — только небольшие, до ~3 МБ). Возвращает публичную ссылку. */
export declare function uploadPublicFile(folder: string, filename: string, buffer: Buffer, contentType: string): Promise<{
    url: string;
    storage: StorageKind;
}>;
/**
 * Одноразовая ссылка для загрузки прямо из браузера в R2 (действует 10 минут).
 * Браузер делает PUT на uploadUrl с тем же Content-Type — файл в Vercel не попадает.
 */
export declare function presignR2Upload(filename: string, contentType: string): Promise<{
    uploadUrl: string;
    url: string;
    expiresIn: number;
}>;
export declare const CHUNK_PREFIX = "tmp-upload";
export declare function r2PutChunk(uploadId: string, index: number, body: Buffer): Promise<void>;
/** Склеить куски 0..total-1 в видео, сохранить в R2 и удалить временные куски. */
export declare function r2CompleteChunks(uploadId: string, total: number, filename: string, contentType: string, maxBytes: number): Promise<{
    url: string;
    bytes: number;
}>;
