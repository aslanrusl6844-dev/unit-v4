/**
 * Импорт товаров витрины из Excel (шаблон «Товары»: Артикул *, Название *, Категория *,
 * Подкатегория, Тип *, Код модели, Бренд, Цвет, Размер, Пол, Цена на витрине, ₸ *,
 * Цена до скидки, ₸, Остаток, шт *, Доставка, В продаже, Ссылки на фото, Видео, Описание,
 * Состав / комплектация). Файл разбирает браузер (те же правила, что у загрузки My Market:
 * public/dashboard.js → mmClassifyRows), сюда приходят уже готовые поля строки.
 *
 * Правила обновления существующего товара: обязательные поля (название, категория, тип,
 * цена, остаток, «В продаже») применяются всегда; необязательные — только если ячейка
 * заполнена, пустая ячейка ничего не стирает.
 */
import { isValidShopCategory } from '../config/shopCategories';

export const MAX_IMPORT_BATCH = 25;
export const MAX_ROW_PHOTOS = 10;
export const MAX_ROW_VIDEOS = 3;
const MAX_MONEY = 1_000_000_000;
const MAX_STOCK = 10_000_000;

export interface ImportRow {
  row: number | null;
  sku: string;
  name: string;
  category: string;
  subcategory: string | null;
  type: string;
  shopPrice: number;
  shopOldPrice: number | null;
  shopStock: number;
  shopDelivery: 'rocket' | 'truck' | null;
  shopActive: boolean; // пусто в файле = «да»
  images: string[] | null; // null — ячейка пуста, фото не трогаем
  description: string | null;
  composition: string | null;
  videoUrl: string | null;
}

export interface ImportRowResult {
  ok: true;
  row: ImportRow;
  warnings: string[];
}

const text = (v: unknown, max: number): string | null | { error: true } => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/ /g, ' ').trim();
  if (!s) return null;
  return s.length > max ? { error: true } : s;
};

/** Число из JSON-числа или строки "1 500,5"; пусто → null; мусор → undefined. */
function num(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = String(v).replace(/[\s ]/g, '').replace(',', '.');
  if (!s) return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
}

/** images: JSON-строка / массив / строка со ссылками через | или перенос → http(s)-ссылки без повторов. */
export function parsePhotos(raw: unknown): { urls: string[] | null; skipped: number } {
  if (raw === null || raw === undefined || raw === '') return { urls: null, skipped: 0 };
  let parts: unknown[] = [];
  if (Array.isArray(raw)) parts = raw;
  else {
    const s = String(raw).trim();
    if (!s) return { urls: null, skipped: 0 };
    let parsed: unknown = null;
    if (s.startsWith('[')) {
      try { parsed = JSON.parse(s); } catch { parsed = null; }
    }
    parts = Array.isArray(parsed) ? parsed : s.split(/[|\n\r]+/);
  }
  const all = parts.map((p) => String(p ?? '').trim()).filter(Boolean);
  const good = Array.from(new Set(all.filter((u) => u.length <= 2000 && /^https?:\/\/\S+$/i.test(u)))).slice(0, MAX_ROW_PHOTOS);
  return { urls: good.length ? good : null, skipped: all.length - good.length };
}

/** Одна строка → нормальный вид либо текст ошибки (строка отклоняется, остальные грузятся). */
export function normalizeImportRow(input: Record<string, unknown>): { ok: false; error: string; sku: string } | ImportRowResult {
  const skuRaw = text(input.sku, 100);
  const sku = typeof skuRaw === 'string' ? skuRaw : '';
  const fail = (error: string) => ({ ok: false as const, error, sku });
  if (skuRaw && typeof skuRaw === 'object') return fail('артикул длиннее 100 символов');
  if (!sku) return fail('не указан артикул');

  const name = text(input.name, 300);
  if (name && typeof name === 'object') return fail('название длиннее 300 символов');
  const category = text(input.category, 200);
  const type = text(input.type, 200);
  if (typeof category === 'object' && category) return fail('категория слишком длинная');
  if (typeof type === 'object' && type) return fail('тип слишком длинный');
  const missing: string[] = [];
  if (!name) missing.push('название');
  if (!category) missing.push('категория');
  if (!type) missing.push('тип');

  const price = num(input.shopPrice);
  if (price === undefined || (price !== null && (price < 0 || price > MAX_MONEY))) return fail('Цена на витрине: нужно число от 0');
  if (price === null) missing.push('цена на витрине');
  const stock = num(input.shopStock);
  if (stock === undefined || (stock !== null && (stock < 0 || stock > MAX_STOCK || !Number.isInteger(stock)))) return fail('Остаток: нужно целое число от 0');
  if (stock === null) missing.push('остаток');
  if (missing.length) return fail(`не заполнено: ${missing.join(', ')}`);

  const oldPrice = num(input.shopOldPrice);
  if (oldPrice === undefined || (oldPrice !== null && (oldPrice < 0 || oldPrice > MAX_MONEY))) return fail('Цена до скидки: нужно число от 0');
  const subcategory = text(input.subcategory, 200);
  const description = text(input.description, 5000);
  const composition = text(input.composition, 5000);
  if ((subcategory && typeof subcategory === 'object') || (description && typeof description === 'object') || (composition && typeof composition === 'object')) {
    return fail('слишком длинный текст в одной из ячеек (подкатегория до 200, описание и состав до 5000 символов)');
  }

  const warnings: string[] = [];
  const photos = parsePhotos(input.images);
  if (photos.skipped > 0) warnings.push(`${photos.skipped} ссылок на фото пропущено (нужны http:// или https://)`);

  let videoUrl: string | null = null;
  const v = text(input.videoUrl, 2000);
  if (typeof v === 'string') {
    if (/^https?:\/\/\S+$/i.test(v)) videoUrl = v;
    else warnings.push('ссылка на видео пропущена (нужна http:// или https://)');
  }

  const delivery = input.shopDelivery === 'rocket' || input.shopDelivery === 'truck' ? input.shopDelivery : null;
  const active = input.shopActive === false || input.shopActive === 'false' || input.shopActive === 0 ? false : true;
  const rowNo = typeof input.row === 'number' && Number.isInteger(input.row) && input.row > 0 ? input.row : null;

  return {
    ok: true,
    warnings,
    row: {
      row: rowNo,
      sku,
      name: name as string,
      category: category as string,
      subcategory: typeof subcategory === 'string' ? subcategory : null,
      type: type as string,
      shopPrice: price as number,
      shopOldPrice: oldPrice,
      shopStock: stock as number,
      shopDelivery: delivery,
      shopActive: active,
      images: photos.urls,
      description: typeof description === 'string' ? description : null,
      composition: typeof composition === 'string' ? composition : null,
      videoUrl,
    },
  };
}

/** «В продаже» можно включить только для категории из списка разделов витрины. */
export function resolveActive(wantActive: boolean, category: string): { active: boolean; downgraded: boolean } {
  if (!wantActive) return { active: false, downgraded: false };
  return isValidShopCategory(category) ? { active: true, downgraded: false } : { active: false, downgraded: true };
}

/** Новое видео ставится первым, остальные остаются (без повторов, до MAX_ROW_VIDEOS). */
export function mergeVideos(current: unknown, url: string): string[] {
  const list = Array.isArray(current) ? current.filter((u): u is string => typeof u === 'string' && !!u) : [];
  return [url, ...list.filter((u) => u !== url)].slice(0, MAX_ROW_VIDEOS);
}
