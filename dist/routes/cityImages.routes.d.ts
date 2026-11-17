/**
 * Админка «Картинки городов»: до 10 картинок (слайдов) на город.
 * Файл админка загружает в тот же Blob, что и фото товаров
 * (POST /api/shop/admin/upload), сюда приходит готовая https-ссылка.
 * Вход — Basic admin (глобальный adminAuthMiddleware на /api/*).
 */
export declare const cityImagesAdminRouter: import("express-serve-static-core").Router;
export declare const SLIDES_ORDER: ({
    position: "asc";
    createdAt?: undefined;
} | {
    createdAt: "asc";
    position?: undefined;
})[];
