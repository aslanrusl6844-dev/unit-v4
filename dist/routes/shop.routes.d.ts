export declare const shopRouter: import("express-serve-static-core").Router;
/** Видимость товара ВНУТРИ витрины: те же правила, но включая товары «только для витрин» (showcaseOnly). */
export declare const SHOP_VISIBLE_IN_SHOWCASE_WHERE: {
    readonly shopActive: true;
    readonly shopArchived: false;
    readonly category: {
        readonly not: null;
    };
    readonly shopPrice: {
        readonly not: null;
    };
} | {
    readonly type: {
        readonly not: null;
    };
    readonly shopActive: true;
    readonly shopArchived: false;
    readonly category: {
        readonly not: null;
    };
    readonly shopPrice: {
        readonly not: null;
    };
};
/**
 * Видимость в ОБЩЕМ каталоге My Market (список, категории, поиск, подсказки):
 * товары, созданные внутри витрины (showcaseOnly), сюда не попадают.
 */
export declare const SHOP_VISIBLE_WHERE: {
    readonly showcaseOnly: false;
    readonly shopActive: true;
    readonly shopArchived: false;
    readonly category: {
        readonly not: null;
    };
    readonly shopPrice: {
        readonly not: null;
    };
} | {
    readonly showcaseOnly: false;
    readonly type: {
        readonly not: null;
    };
    readonly shopActive: true;
    readonly shopArchived: false;
    readonly category: {
        readonly not: null;
    };
    readonly shopPrice: {
        readonly not: null;
    };
};
export declare function toShopProduct(p: any): {
    sku: any;
    article: any;
    name: any;
    category: any;
    subcategory: any;
    type: any;
    price: any;
    oldPrice: any;
    wowPercent: number | null;
    wowPrice: number | null;
    wowUntil: any;
    stock: any;
    description: any;
    composition: any;
    characteristics: import("../integrations/ozon.content").ShopCharacteristic[];
    images: string[];
    video: any;
    videoUrl: any;
    delivery: any;
    banner: any;
    bannerTitle: any;
    bannerSubtitle: any;
    quantityVariants: import("../services/productExtras").QuantityVariant[];
    details: string[];
    videos: string[];
};
/**
 * Добор артикула для товаров, ставших видимыми (цена + «В продаже») ДО того,
 * как для них сработала генерация — например, если товар был активен ещё
 * до появления shopArticle в системе, или включён в продажу каким-то путём
 * в обход обычного сохранения карточки. Видимый товар (уже прошёл
 * SHOP_VISIBLE_WHERE — значит и цена, и активность на месте) обязан иметь
 * артикул; если его почему-то нет — генерируем прямо здесь, один раз,
 * той же функцией и по тому же правилу, что и при сохранении карточки.
 * Без этого приложению просто нечего было бы подставить в sku/article
 * кроме внутреннего ozon-.../wb-.../kaspi-... — собственно тот самый баг.
 */
export declare function ensureShopArticle<T extends {
    id: string;
    shopArticle: string | null;
    shopPrice: number | null;
    shopActive: boolean;
}>(product: T): Promise<T>;
/**
 * Рейтинг и число отзывов для списка товаров — ОДИН groupBy на всех сразу
 * (не запрос на каждый товар), считая по обеим формам sku товара
 * (внутренний sku И shopArticle — так же, как ищет GET /reviews), иначе
 * отзывы, сохранённые под ozon-..., не попадут в рейтинг витрины.
 * rating — среднее, округлённое до 1 знака, нет отзывов → null.
 * reviewCount — число отзывов, нет → 0.
 */
export declare function getReviewStatsMap(products: Array<{
    id: string;
    sku: string;
    shopArticle: string | null;
}>): Promise<Map<string, {
    rating: number | null;
    reviewCount: number;
}>>;
/**
 * Варианты одной витрины (цвет/размер) — другие товары с тем же
 * variantGroup, ТОЛЬКО видимые (shopActive, не архив). Текущий товар тоже
 * входит в свой собственный массив (если сам видим). Нет группы -> [].
 * Один запрос на весь список сразу (по всем встреченным variantGroup),
 * не по одному на товар.
 */
declare function variantToDto(m: {
    sku: string;
    shopArticle: string | null;
    name: string;
    variantLabel: string | null;
    shopPrice: number | null;
    shopOldPrice: number | null;
    shopStock: number;
    images: string | null;
}): {
    sku: string;
    name: string;
    variantLabel: string | null;
    price: number | null;
    oldPrice: number | null;
    stock: number;
    image: string;
};
export declare function getProductVariantsMap(products: Array<{
    id: string;
    variantGroup: string | null;
}>): Promise<Map<string, ReturnType<typeof variantToDto>[]>>;
/** E-mail для чека: только похожий на настоящий адрес, иначе null. */
export declare function cleanEmail(v: unknown): string | null;
/**
 * Подтверждение оплаты — сейчас вызывается продавцом вручную после того,
 * как проверил QR/перевод (веб-хук платёжной системы можно подключить сюда
 * же позже, эндпоинт для этого уже есть). При оплате:
 *  1) статус ShopOrder -> paid, списывается остаток (shopStock).
 *  2) создаётся Order+OrderItem с marketplace=APP — чтобы заказ сразу
 *     попал в общую юнит-экономику (Обзор/Финансы/Товары), без отдельного
 *     параллельного пути отчётности.
 */
/**
 * Общая логика перехода ShopOrder в paid — списание остатка + создание
 * Order/OrderItem для юнит-экономики. Используется и клиентским
 * /orders/:id/paid (пока — ручное подтверждение продавцом, в будущем —
 * вебхук эквайринга), и админской кнопкой «Отметить оплаченным» — ОДИН
 * код на оба пути, поэтому повторное списание физически невозможно: и там,
 * и там первым делом проверяется, что заказ ещё pending_payment.
 */
export declare function markShopOrderAsPaid(orderId: string): Promise<{
    ok: true;
} | {
    ok: false;
    reason: 'not_found';
} | {
    ok: false;
    reason: 'wrong_status';
    status: string;
}>;
/** Сравнение телефонов только по цифрам (последние 10) — терпимо к
 *  разным форматам записи (+7 xxx, 8xxx, пробелы/дефисы и т.п.). */
/**
 * Нормализация номера телефона к канонической форме "7XXXXXXXXXX" (11 цифр,
 * без +/пробелов/скобок/дефисов). 8XXXXXXXXXX, 7XXXXXXXXXX и +7XXXXXXXXXX —
 * один и тот же номер, приводятся к одному виду. Возвращает null, если
 * после нормализации не получился похожий на телефон номер (не 10-11 цифр).
 */
export declare function normalizePhone(raw: string): string | null;
/** Уведомить покупателя о подтверждении подписки (используется админкой). */
export declare function notifyWowActivated(phone: string, endsAt: Date): Promise<void>;
export {};
