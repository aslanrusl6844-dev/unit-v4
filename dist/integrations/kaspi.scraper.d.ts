export interface CompetitorPrice {
    price: number;
    sellerName?: string;
}
export interface ProductPageInfo {
    name?: string;
    price?: number;
    ratingValue?: number;
    reviewCount?: number;
    category?: string;
}
/**
 * Читает базовую информацию о товаре (название, цену, рейтинг, число
 * отзывов) со страницы kaspi.kz. У Kaspi нет API для отзывов у партнёров —
 * поэтому берём то же, что видят поисковики: структурированную разметку
 * schema.org/Product (JSON-LD), которую сайты обычно кладут в обычный HTML
 * специально для SEO — она не требует выполнения JavaScript и не зависит
 * от логина в кабинет.
 */
export declare function fetchProductPageInfo(productUrl: string): Promise<ProductPageInfo>;
export declare function fetchCompetitorPrices(productUrl: string): Promise<CompetitorPrice[]>;
/**
 * Фото товара со страницы kaspi.kz (публичная страница, только чтение).
 * Официальный API Kaspi фото товаров не отдаёт, поэтому — то же, что видят
 * поисковики: JSON-LD schema.org/Product (поле image), запасной вариант —
 * og:image. Возвращает:
 *   string[] — фото найдены (главное первым), либо [] — страница открылась,
 *              но фото на ней нет;
 *   null     — страницу прочитать не удалось (сеть/блокировка/таймаут) —
 *              вызывающий код НЕ должен считать такой товар "проверенным".
 * Таймаут короткий (6 c) — вызывается пачкой из serverless-функции.
 */
export declare function fetchProductImages(productUrl: string): Promise<string[] | null>;
