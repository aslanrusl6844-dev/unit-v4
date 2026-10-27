/**
 * Большая карусель витрины: bigBanners (URL) + параллельные массивы bigBannerTexts /
 * bigBannerTextColors / bigBannerFontStyles — по одному элементу на баннер, в том же порядке.
 * Старые витрины (только URL) работают: текст = null, цвет = белый, шрифт = normal.
 * Текст многострочный (\n сохраняется).
 */
export const BANNER_TEXT_COLORS = ['white', 'black'] as const;
export type BannerTextColor = (typeof BANNER_TEXT_COLORS)[number];
export const DEFAULT_BANNER_TEXT_COLOR: BannerTextColor = 'white';
export const BANNER_FONT_STYLES = ['normal', 'bold', 'large'] as const; // обычный / жирный / крупный жирный
export type BannerFontStyle = (typeof BANNER_FONT_STYLES)[number];
export const DEFAULT_BANNER_FONT_STYLE: BannerFontStyle = 'normal';

export interface BigBannerItem {
  url: string;
  text: string | null;
  textColor: BannerTextColor;
  fontStyle: BannerFontStyle;
}

const asFont = (v: unknown): BannerFontStyle => (v === 'bold' || v === 'large' ? v : DEFAULT_BANNER_FONT_STYLE);
/** Переводы строк приводим к \n, пробелы по краям убираем; пусто → null. */
const asText = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '';
  return t || null;
};

const asColor = (v: unknown): BannerTextColor => (v === 'black' ? 'black' : DEFAULT_BANNER_TEXT_COLOR);

/** Элементы карусели из строки витрины. Нет текстов/цветов (старые записи) — по умолчанию. Пусто и есть bannerUrl — запасной баннер. */
export function bigBannerItemsOf(row: any): BigBannerItem[] {
  const urls: string[] = Array.isArray(row?.bigBanners) ? row.bigBanners.filter((u: unknown) => typeof u === 'string') : [];
  const texts: unknown[] = Array.isArray(row?.bigBannerTexts) ? row.bigBannerTexts : [];
  const colors: unknown[] = Array.isArray(row?.bigBannerTextColors) ? row.bigBannerTextColors : [];
  const fonts: unknown[] = Array.isArray(row?.bigBannerFontStyles) ? row.bigBannerFontStyles : [];
  if (!urls.length) {
    return row?.bannerUrl ? [{ url: row.bannerUrl, text: null, textColor: DEFAULT_BANNER_TEXT_COLOR, fontStyle: DEFAULT_BANNER_FONT_STYLE }] : [];
  }
  return urls.map((url, i) => {
    return { url, text: asText(texts[i]), textColor: asColor(colors[i]), fontStyle: asFont(fonts[i]) };
  });
}

export interface BigBannerWrite {
  bigBanners: string[];
  bigBannerTexts: string[];
  bigBannerTextColors: string[];
  bigBannerFontStyles: string[];
}

/**
 * Что записать в БД. items — полный список {url, text, textColor} (админка); либо urls — только
 * ссылки (старый клиент): тогда текст и цвет берутся из прежних данных витрины по URL.
 * Повторы ссылок убираются (остаётся первый). Ни того ни другого — null (поле не трогаем).
 */
export function resolveBigBannerWrite(
  input: { items?: Array<{ url: string; text?: string | null; textColor?: string; fontStyle?: string }>; urls?: string[] },
  existing?: any,
): BigBannerWrite | null {
  let items: BigBannerItem[];
  if (input.items !== undefined) {
    items = input.items.map((it) => ({ url: it.url, text: asText(it.text), textColor: asColor(it.textColor), fontStyle: asFont(it.fontStyle) }));
  } else if (input.urls !== undefined) {
    const prev = new Map(bigBannerItemsOfRaw(existing).map((it) => [it.url, it]));
    items = input.urls.map((url) => prev.get(url) ?? { url, text: null, textColor: DEFAULT_BANNER_TEXT_COLOR, fontStyle: DEFAULT_BANNER_FONT_STYLE });
  } else {
    return null;
  }
  const seen = new Set<string>();
  const unique = items.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)));
  return {
    bigBanners: unique.map((it) => it.url),
    bigBannerTexts: unique.map((it) => it.text ?? ''),
    bigBannerTextColors: unique.map((it) => it.textColor),
    bigBannerFontStyles: unique.map((it) => it.fontStyle),
  };
}

/** Как bigBannerItemsOf, но без запасного bannerUrl (для сопоставления прежних данных). */
function bigBannerItemsOfRaw(row: any): BigBannerItem[] {
  return bigBannerItemsOf({ ...row, bannerUrl: null });
}
