/**
 * Большая карусель витрины: bigBanners (URL) + параллельные массивы bigBannerTexts /
 * bigBannerSizes / bigBannerTextColors — по одному элементу на баннер, в том же порядке.
 * Текст многострочный (\n), у каждой строки свой размер в процентах (1–100); в БД размеры
 * баннера лежат одной строкой "30,15" (по числу в строке текста).
 * Старые витрины (только URL / текст без размеров) работают: текст = null, цвет = белый,
 * размер каждой строки = 20.
 * Колонка bigBannerFontStyles (прежний выбор шрифта) больше не используется и не отдаётся.
 */
export declare const BANNER_TEXT_COLORS: readonly ["white", "black"];
export type BannerTextColor = (typeof BANNER_TEXT_COLORS)[number];
export declare const DEFAULT_BANNER_TEXT_COLOR: BannerTextColor;
export declare const MIN_LINE_SIZE = 1;
export declare const MAX_LINE_SIZE = 100;
export declare const DEFAULT_LINE_SIZE = 20;
export interface BigBannerItem {
    url: string;
    text: string | null;
    sizes: number[];
    textColor: BannerTextColor;
}
/** Размер строки: целое 1–100; всё остальное → 20. */
export declare const asSize: (v: unknown) => number;
/**
 * Текст + размеры → нормальный вид: \r\n → \n, у строк убраны пробелы по краям, пустые строки в
 * начале и в конце срезаны (вместе с их размерами), размер i-й строки = sizes[i] или 20.
 * Пусто → { text: null, sizes: [] }.
 */
export declare function normalizeBannerText(text: unknown, sizes?: unknown[] | null): {
    text: string | null;
    sizes: number[];
};
/** Элементы карусели из строки витрины. Нет текстов/размеров/цветов (старые записи) — по умолчанию. Пусто и есть bannerUrl — запасной баннер. */
export declare function bigBannerItemsOf(row: any): BigBannerItem[];
export interface BigBannerWrite {
    bigBanners: string[];
    bigBannerTexts: string[];
    bigBannerSizes: string[];
    bigBannerTextColors: string[];
}
/**
 * Что записать в БД. items — полный список {url, text, sizes, textColor} (админка); либо urls — только
 * ссылки (старый клиент): тогда текст, размеры и цвет берутся из прежних данных витрины по URL.
 * Повторы ссылок убираются (остаётся первый). Ни того ни другого — null (поле не трогаем).
 */
export declare function resolveBigBannerWrite(input: {
    items?: Array<{
        url: string;
        text?: string | null;
        sizes?: number[];
        textColor?: string;
    }>;
    urls?: string[];
}, existing?: any): BigBannerWrite | null;
