/**
 * Большая карусель витрины: bigBanners (URL) + параллельные массивы bigBannerTexts /
 * bigBannerTextColors — по одному элементу на баннер, в том же порядке. Старые витрины
 * (только URL) работают: текст = null, цвет = белый.
 */
export const BANNER_TEXT_COLORS = ['white', 'black'] as const;
export type BannerTextColor = (typeof BANNER_TEXT_COLORS)[number];
export const DEFAULT_BANNER_TEXT_COLOR: BannerTextColor = 'white';

export interface BigBannerItem {
  url: string;
  text: string | null;
  textColor: BannerTextColor;
}

const asColor = (v: unknown): BannerTextColor => (v === 'black' ? 'black' : DEFAULT_BANNER_TEXT_COLOR);

/** Элементы карусели из строки витрины. Нет текстов/цветов (старые записи) — по умолчанию. Пусто и есть bannerUrl — запасной баннер. */
export function bigBannerItemsOf(row: any): BigBannerItem[] {
  const urls: string[] = Array.isArray(row?.bigBanners) ? row.bigBanners.filter((u: unknown) => typeof u === 'string') : [];
  const texts: unknown[] = Array.isArray(row?.bigBannerTexts) ? row.bigBannerTexts : [];
  const colors: unknown[] = Array.isArray(row?.bigBannerTextColors) ? row.bigBannerTextColors : [];
  if (!urls.length) {
    return row?.bannerUrl ? [{ url: row.bannerUrl, text: null, textColor: DEFAULT_BANNER_TEXT_COLOR }] : [];
  }
  return urls.map((url, i) => {
    const t = typeof texts[i] === 'string' ? (texts[i] as string).trim() : '';
    return { url, text: t || null, textColor: asColor(colors[i]) };
  });
}

export interface BigBannerWrite {
  bigBanners: string[];
  bigBannerTexts: string[];
  bigBannerTextColors: string[];
}

/**
 * Что записать в БД. items — полный список {url, text, textColor} (админка); либо urls — только
 * ссылки (старый клиент): тогда текст и цвет берутся из прежних данных витрины по URL.
 * Повторы ссылок убираются (остаётся первый). Ни того ни другого — null (поле не трогаем).
 */
export function resolveBigBannerWrite(
  input: { items?: Array<{ url: string; text?: string | null; textColor?: string }>; urls?: string[] },
  existing?: any,
): BigBannerWrite | null {
  let items: BigBannerItem[];
  if (input.items !== undefined) {
    items = input.items.map((it) => ({ url: it.url, text: (it.text ?? '').trim() || null, textColor: asColor(it.textColor) }));
  } else if (input.urls !== undefined) {
    const prev = new Map(bigBannerItemsOfRaw(existing).map((it) => [it.url, it]));
    items = input.urls.map((url) => prev.get(url) ?? { url, text: null, textColor: DEFAULT_BANNER_TEXT_COLOR });
  } else {
    return null;
  }
  const seen = new Set<string>();
  const unique = items.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)));
  return {
    bigBanners: unique.map((it) => it.url),
    bigBannerTexts: unique.map((it) => it.text ?? ''),
    bigBannerTextColors: unique.map((it) => it.textColor),
  };
}

/** Как bigBannerItemsOf, но без запасного bannerUrl (для сопоставления прежних данных). */
function bigBannerItemsOfRaw(row: any): BigBannerItem[] {
  return bigBannerItemsOf({ ...row, bannerUrl: null });
}
