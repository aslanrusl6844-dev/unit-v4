/**
 * Большая карусель витрины: bigBanners (URL) + параллельные массивы bigBannerTexts /
 * bigBannerSizes / bigBannerTextColors — по одному элементу на баннер, в том же порядке.
 * Текст многострочный (\n), у каждой строки свой размер в процентах (1–100); в БД размеры
 * баннера лежат одной строкой "30,15" (по числу в строке текста).
 * Старые витрины (только URL / текст без размеров) работают: текст = null, цвет = белый,
 * размер каждой строки = 20.
 * Колонка bigBannerFontStyles (прежний выбор шрифта) больше не используется и не отдаётся.
 */
export const BANNER_TEXT_COLORS = ['white', 'black'] as const;
export type BannerTextColor = (typeof BANNER_TEXT_COLORS)[number];
export const DEFAULT_BANNER_TEXT_COLOR: BannerTextColor = 'white';
export const MIN_LINE_SIZE = 1;
export const MAX_LINE_SIZE = 100;
export const DEFAULT_LINE_SIZE = 20;

export interface BigBannerItem {
  url: string;
  text: string | null;
  sizes: number[]; // размер (%) каждой строки text; text = null → []
  textColor: BannerTextColor;
}

const asColor = (v: unknown): BannerTextColor => (v === 'black' ? 'black' : DEFAULT_BANNER_TEXT_COLOR);

/** Размер строки: целое 1–100; всё остальное → 20. */
export const asSize = (v: unknown): number => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Math.round(Number(v));
  return Number.isFinite(n) && n >= MIN_LINE_SIZE && n <= MAX_LINE_SIZE ? n : DEFAULT_LINE_SIZE;
};

/** "30,15" → [30, 15] (из БД). */
const parseSizes = (v: unknown): unknown[] => (typeof v === 'string' && v.trim() ? v.split(',') : []);

/**
 * Текст + размеры → нормальный вид: \r\n → \n, у строк убраны пробелы по краям, пустые строки в
 * начале и в конце срезаны (вместе с их размерами), размер i-й строки = sizes[i] или 20.
 * Пусто → { text: null, sizes: [] }.
 */
export function normalizeBannerText(text: unknown, sizes?: unknown[] | null): { text: string | null; sizes: number[] } {
  if (typeof text !== 'string') return { text: null, sizes: [] };
  let pairs = text.replace(/\r\n?/g, '\n').split('\n').map((l, i) => ({ t: l.trim(), s: asSize(sizes?.[i]) }));
  while (pairs.length && !pairs[0].t) pairs.shift();
  while (pairs.length && !pairs[pairs.length - 1].t) pairs.pop();
  if (!pairs.length) return { text: null, sizes: [] };
  return { text: pairs.map((p) => p.t).join('\n'), sizes: pairs.map((p) => p.s) };
}

/** Элементы карусели из строки витрины. Нет текстов/размеров/цветов (старые записи) — по умолчанию. Пусто и есть bannerUrl — запасной баннер. */
export function bigBannerItemsOf(row: any): BigBannerItem[] {
  const urls: string[] = Array.isArray(row?.bigBanners) ? row.bigBanners.filter((u: unknown) => typeof u === 'string') : [];
  const texts: unknown[] = Array.isArray(row?.bigBannerTexts) ? row.bigBannerTexts : [];
  const sizes: unknown[] = Array.isArray(row?.bigBannerSizes) ? row.bigBannerSizes : [];
  const colors: unknown[] = Array.isArray(row?.bigBannerTextColors) ? row.bigBannerTextColors : [];
  if (!urls.length) {
    return row?.bannerUrl ? [{ url: row.bannerUrl, text: null, sizes: [], textColor: DEFAULT_BANNER_TEXT_COLOR }] : [];
  }
  return urls.map((url, i) => {
    const n = normalizeBannerText(texts[i], parseSizes(sizes[i]));
    return { url, text: n.text, sizes: n.sizes, textColor: asColor(colors[i]) };
  });
}

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
export function resolveBigBannerWrite(
  input: { items?: Array<{ url: string; text?: string | null; sizes?: number[]; textColor?: string }>; urls?: string[] },
  existing?: any,
): BigBannerWrite | null {
  let items: BigBannerItem[];
  if (input.items !== undefined) {
    items = input.items.map((it) => {
      const n = normalizeBannerText(it.text, it.sizes);
      return { url: it.url, text: n.text, sizes: n.sizes, textColor: asColor(it.textColor) };
    });
  } else if (input.urls !== undefined) {
    const prev = new Map(bigBannerItemsOfRaw(existing).map((it) => [it.url, it]));
    items = input.urls.map((url) => prev.get(url) ?? { url, text: null, sizes: [], textColor: DEFAULT_BANNER_TEXT_COLOR });
  } else {
    return null;
  }
  const seen = new Set<string>();
  const unique = items.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)));
  return {
    bigBanners: unique.map((it) => it.url),
    bigBannerTexts: unique.map((it) => it.text ?? ''),
    bigBannerSizes: unique.map((it) => it.sizes.join(',')),
    bigBannerTextColors: unique.map((it) => it.textColor),
  };
}

/** Как bigBannerItemsOf, но без запасного bannerUrl (для сопоставления прежних данных). */
function bigBannerItemsOfRaw(row: any): BigBannerItem[] {
  return bigBannerItemsOf({ ...row, bannerUrl: null });
}
