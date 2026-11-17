/**
 * Очистка контента Ozon для карточки My Market. Чистые функции, без обращений
 * к сети и базе — чтобы правила легко проверять и переиспользовать и в синке
 * (запись в базу), и в API приложения (страховка при чтении).
 *
 * Правило: из Ozon берём только то, что имеет смысл для покупателя. Хештеги,
 * ТН ВЭД, код маркировки, код продавца, «Нет бренда», служебные true/false —
 * не показываем нигде.
 */
export declare function isGarbageValue(v: string | null | undefined): boolean;
/**
 * Описание = только аннотация товара, без оферты, «доставки по РФ»,
 * хештегов, ТН ВЭД, кодов и артикула. Чистим по предложениям: хештег внутри
 * предложения просто вырезается, предложение с «мусорными» маркерами
 * выбрасывается целиком. Возвращает '' если после чистки ничего не осталось.
 */
export declare function cleanOzonDescription(raw: string | null | undefined): string;
/** Чистый текст состава: без хештегов и пустышек. '' если чистить нечего. */
export declare function cleanOzonComposition(raw: string | null | undefined): string;
/** Название атрибута Ozon — это именно «Состав» / «Состав/ингредиенты». */
export declare function isCompositionAttributeName(name: string | null | undefined): boolean;
export declare function isMaterialAttributeName(name: string | null | undefined): boolean;
/** Текст похож на свалку атрибутов Ozon (то, что раньше писал синк в состав). */
export declare function looksLikeAttributeDump(text: string | null | undefined): boolean;
/**
 * Свалка прежнего формата синка: строки «Название: значение» по всем атрибутам.
 * Применяется ТОЛЬКО к тексту, который записал сам синк (compositionSource =
 * "ozon"): чистый состав — это один связный текст, а не список «ключ: значение».
 */
export declare function looksLikeLegacySyncDump(text: string | null | undefined): boolean;
export interface ShopCharacteristic {
    name: string;
    value: string;
}
/** Оставляет только Тип / Материал / Артикул с нормальными значениями, в этом порядке. */
export declare function sanitizeCharacteristics(list: Array<{
    name?: unknown;
    value?: unknown;
}> | null | undefined): ShopCharacteristic[];
/**
 * Короткий список характеристик товара Ozon: Тип, Материал, Артикул.
 * «Артикул» — ТОЛЬКО shopArticle (свой, 7 цифр, генерируется отдельно) — сюда
 * НИКОГДА не передаётся offerId/nmId/kaspiSku площадки. Если shopArticle ещё
 * не сгенерирован (у товара пока нет ни цены, ни «В продаже») — строки
 * «Артикул» в характеристиках просто не будет, это не ошибка.
 */
export declare function buildCharacteristics(input: {
    typeName?: string;
    material?: string;
    shopArticle?: string | null;
}): ShopCharacteristic[];
