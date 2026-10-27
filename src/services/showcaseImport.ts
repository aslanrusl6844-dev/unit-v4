/**
 * Импорт товаров витрины из Excel: нормализация одной строки файла.
 * Колонки файла: Артикул, Название, Цена, Старая цена, Описание, Ссылка на фото.
 * Пустая ячейка = «не менять» (у существующего товара) / «нет значения» (у нового).
 */
export interface ImportRowInput {
  row?: number;
  article?: unknown;
  name?: unknown;
  price?: unknown;
  oldPrice?: unknown;
  description?: unknown;
  photo?: unknown;
}

export interface ImportRow {
  row: number | null;
  article: string;
  name: string | null;
  price: number | null;
  oldPrice: number | null;
  description: string | null;
  photo: string | null;
}

export const MAX_IMPORT_BATCH = 25;
const MAX_PRICE = 1_000_000_000;

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\u00a0/g, ' ').trim();
  return s ? s : null;
};

/** "1 500,50" / "1500.5" / 1500 → число ≥ 0; пусто → null; всё остальное → ошибка. */
function money(v: unknown, label: string): number | null | { error: string } {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0 || v > MAX_PRICE) return { error: `${label}: нужно число от 0` };
    return v;
  }
  const s = String(v).replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: `${label}: «${String(v).trim()}» — нужно число` };
  const n = Number(s);
  return n <= MAX_PRICE ? n : { error: `${label}: слишком большое число` };
}

/** Одна строка → нормальный вид либо текст ошибки. */
export function normalizeImportRow(input: ImportRowInput): { ok: true; row: ImportRow } | { ok: false; error: string } {
  const article = str(input.article);
  if (!article) return { ok: false, error: 'не указан артикул' };
  if (article.length > 100) return { ok: false, error: 'артикул длиннее 100 символов' };
  const name = str(input.name);
  if (name && name.length > 300) return { ok: false, error: 'название длиннее 300 символов' };
  const description = str(input.description);
  if (description && description.length > 5000) return { ok: false, error: 'описание длиннее 5000 символов' };
  const price = money(input.price, 'Цена');
  if (price !== null && typeof price === 'object') return { ok: false, error: price.error };
  const oldPrice = money(input.oldPrice, 'Старая цена');
  if (oldPrice !== null && typeof oldPrice === 'object') return { ok: false, error: oldPrice.error };
  const photo = str(input.photo);
  if (photo && (photo.length > 2000 || !/^https?:\/\/\S+$/i.test(photo))) {
    return { ok: false, error: 'Ссылка на фото: нужен адрес, начинающийся с http:// или https://' };
  }
  const rowNo = typeof input.row === 'number' && Number.isInteger(input.row) && input.row > 0 ? input.row : null;
  return { ok: true, row: { row: rowNo, article, name, price, oldPrice, description, photo } };
}

/** Новое фото ставится первым, остальные фото товара остаются (без повторов). */
export function mergePhoto(currentImagesJson: string | null | undefined, photo: string): string {
  let list: string[] = [];
  try {
    const parsed = currentImagesJson ? JSON.parse(currentImagesJson) : [];
    if (Array.isArray(parsed)) list = parsed.filter((u): u is string => typeof u === 'string' && !!u);
  } catch {
    list = [];
  }
  return JSON.stringify([photo, ...list.filter((u) => u !== photo)]);
}
