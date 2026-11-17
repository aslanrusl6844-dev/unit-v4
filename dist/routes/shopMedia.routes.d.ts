export declare const shopMediaRouter: import("express-serve-static-core").Router;
/**
 * Баннеры главной (4 слота): purpose='banner' разрешает ещё GIF и короткие видео MP4/WEBM.
 * Через сервер — 3 000 000 байт (в base64 ~4.0 МБ, как и у express.json()).
 */
export declare const BANNER_ALLOWED_TYPES: string[];
export declare const MAX_BANNER_BYTES = 3000000;
/** Видео товара и витрины (purpose='video'): только MP4/WEBM. */
export declare const VIDEO_ALLOWED_TYPES: string[];
/** Предел видео при прямой загрузке в R2 (мимо Vercel). */
export declare const DIRECT_MAX_VIDEO_BYTES: number;
/** Размер куска: ниже предела Vercel на тело запроса (~4.5 МБ). */
export declare const VIDEO_CHUNK_BYTES: number;
