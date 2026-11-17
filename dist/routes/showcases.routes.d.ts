/**
 * Подбаннерные витрины брендов и магазинов — ПУБЛИЧНАЯ часть для приложения.
 * Путь: /api/shop/showcases/... Доступ — тот же x-app-key, что у /api/shop/*
 * (проверка своя, как у yardRouter). Здесь только чтение и только опубликованное;
 * никаких административных полей (published, sortOrder, даты, id связей) наружу
 * не отдаётся. Управление витринами — showcasesAdmin.routes.ts (вход Basic).
 *
 * Товары витрины = ТОЛЬКО явные привязки (ShowcaseProduct / ShowcaseCollectionItem),
 * никакого подбора по названию. Видимость самого товара — общий фильтр каталога
 * SHOP_VISIBLE_IN_SHOWCASE_WHERE (те же правила видимости, но товары «только для витрин» допускаются): скрытый/архивный товар в витрине не показывается, но
 * привязка при этом не теряется.
 */
export declare const showcasesRouter: import("express-serve-static-core").Router;
/** Витрина для списка/шапки — только публичные поля. */
/** Бегущая строка витрины: по умолчанию чёрная полоса, белые буквы, шрифт 20. */
export declare const TICKER_DEFAULT_SIZE = 20;
export declare function tickerOf(s: any): {
    tickerText: any;
    tickerBg: string;
    tickerColor: string;
    tickerSize: any;
} | {
    tickerText: null;
    tickerBg: null;
    tickerColor: null;
    tickerSize: null;
};
