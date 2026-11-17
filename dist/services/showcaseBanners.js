"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asSize = exports.DEFAULT_LINE_SIZE = exports.MAX_LINE_SIZE = exports.MIN_LINE_SIZE = exports.DEFAULT_BANNER_TEXT_COLOR = exports.BANNER_TEXT_COLORS = void 0;
exports.normalizeBannerText = normalizeBannerText;
exports.bigBannerItemsOf = bigBannerItemsOf;
exports.resolveBigBannerWrite = resolveBigBannerWrite;
/**
 * Большая карусель витрины: bigBanners (URL) + параллельные массивы bigBannerTexts /
 * bigBannerSizes / bigBannerTextColors — по одному элементу на баннер, в том же порядке.
 * Текст многострочный (\n), у каждой строки свой размер в процентах (1–100); в БД размеры
 * баннера лежат одной строкой "30,15" (по числу в строке текста).
 * Старые витрины (только URL / текст без размеров) работают: текст = null, цвет = белый,
 * размер каждой строки = 20.
 * Колонка bigBannerFontStyles (прежний выбор шрифта) больше не используется и не отдаётся.
 */
exports.BANNER_TEXT_COLORS = ['white', 'black'];
exports.DEFAULT_BANNER_TEXT_COLOR = 'white';
exports.MIN_LINE_SIZE = 1;
exports.MAX_LINE_SIZE = 100;
exports.DEFAULT_LINE_SIZE = 20;
const asColor = (v) => (v === 'black' ? 'black' : exports.DEFAULT_BANNER_TEXT_COLOR);
/** Размер строки: целое 1–100; всё остальное → 20. */
const asSize = (v) => {
    const n = typeof v === 'string' && v.trim() === '' ? NaN : Math.round(Number(v));
    return Number.isFinite(n) && n >= exports.MIN_LINE_SIZE && n <= exports.MAX_LINE_SIZE ? n : exports.DEFAULT_LINE_SIZE;
};
exports.asSize = asSize;
/** "30,15" → [30, 15] (из БД). */
const parseSizes = (v) => (typeof v === 'string' && v.trim() ? v.split(',') : []);
/**
 * Текст + размеры → нормальный вид: \r\n → \n, у строк убраны пробелы по краям, пустые строки в
 * начале и в конце срезаны (вместе с их размерами), размер i-й строки = sizes[i] или 20.
 * Пусто → { text: null, sizes: [] }.
 */
function normalizeBannerText(text, sizes) {
    if (typeof text !== 'string')
        return { text: null, sizes: [] };
    let pairs = text.replace(/\r\n?/g, '\n').split('\n').map((l, i) => ({ t: l.trim(), s: (0, exports.asSize)(sizes?.[i]) }));
    while (pairs.length && !pairs[0].t)
        pairs.shift();
    while (pairs.length && !pairs[pairs.length - 1].t)
        pairs.pop();
    if (!pairs.length)
        return { text: null, sizes: [] };
    return { text: pairs.map((p) => p.t).join('\n'), sizes: pairs.map((p) => p.s) };
}
/** Элементы карусели из строки витрины. Нет текстов/размеров/цветов (старые записи) — по умолчанию. Пусто и есть bannerUrl — запасной баннер. */
function bigBannerItemsOf(row) {
    const urls = Array.isArray(row?.bigBanners) ? row.bigBanners.filter((u) => typeof u === 'string') : [];
    const texts = Array.isArray(row?.bigBannerTexts) ? row.bigBannerTexts : [];
    const sizes = Array.isArray(row?.bigBannerSizes) ? row.bigBannerSizes : [];
    const colors = Array.isArray(row?.bigBannerTextColors) ? row.bigBannerTextColors : [];
    if (!urls.length) {
        return row?.bannerUrl ? [{ url: row.bannerUrl, text: null, sizes: [], textColor: exports.DEFAULT_BANNER_TEXT_COLOR }] : [];
    }
    return urls.map((url, i) => {
        const n = normalizeBannerText(texts[i], parseSizes(sizes[i]));
        return { url, text: n.text, sizes: n.sizes, textColor: asColor(colors[i]) };
    });
}
/**
 * Что записать в БД. items — полный список {url, text, sizes, textColor} (админка); либо urls — только
 * ссылки (старый клиент): тогда текст, размеры и цвет берутся из прежних данных витрины по URL.
 * Повторы ссылок убираются (остаётся первый). Ни того ни другого — null (поле не трогаем).
 */
function resolveBigBannerWrite(input, existing) {
    let items;
    if (input.items !== undefined) {
        items = input.items.map((it) => {
            const n = normalizeBannerText(it.text, it.sizes);
            return { url: it.url, text: n.text, sizes: n.sizes, textColor: asColor(it.textColor) };
        });
    }
    else if (input.urls !== undefined) {
        const prev = new Map(bigBannerItemsOfRaw(existing).map((it) => [it.url, it]));
        items = input.urls.map((url) => prev.get(url) ?? { url, text: null, sizes: [], textColor: exports.DEFAULT_BANNER_TEXT_COLOR });
    }
    else {
        return null;
    }
    const seen = new Set();
    const unique = items.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)));
    return {
        bigBanners: unique.map((it) => it.url),
        bigBannerTexts: unique.map((it) => it.text ?? ''),
        bigBannerSizes: unique.map((it) => it.sizes.join(',')),
        bigBannerTextColors: unique.map((it) => it.textColor),
    };
}
/** Как bigBannerItemsOf, но без запасного bannerUrl (для сопоставления прежних данных). */
function bigBannerItemsOfRaw(row) {
    return bigBannerItemsOf({ ...row, bannerUrl: null });
}
//# sourceMappingURL=showcaseBanners.js.map