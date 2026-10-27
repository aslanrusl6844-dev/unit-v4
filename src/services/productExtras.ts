import { z } from 'zod';

/**
 * Варианты количества (1/2/3/4 шт или кг, у каждого своя цена): JSON-строка в
 * Product.quantityVariants. «Детали» (фото/видео): массив URL в Product.details (Json).
 */
export const MAX_QUANTITY_VARIANTS = 20;
export const MAX_DETAILS = 10;
export const MAX_VIDEOS = 3; // у товара
export const MAX_SHOWCASE_VIDEOS = 20; // у витрины
export const QUANTITY_UNITS = ['шт', 'кг'] as const;

export type QuantityVariant = { quantity: number; unit: (typeof QUANTITY_UNITS)[number]; price: number };

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => /^https?:\/\/\S+$/i.test(u), 'url должен начинаться с http:// или https://');

export const quantityVariantSchema = z.object({
  quantity: z.number().positive().max(100000),
  unit: z.enum(QUANTITY_UNITS).optional().default('шт'),
  price: z.number().nonnegative().max(1e9),
});

export const quantityVariantsSchema = z
  .array(quantityVariantSchema)
  .max(MAX_QUANTITY_VARIANTS)
  .superRefine((arr, ctx) => {
    const seen = new Set<string>();
    arr.forEach((v, i) => {
      const k = `${v.quantity}|${v.unit}`;
      if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `Вариант ${v.quantity} ${v.unit} повторяется`, path: [i, 'quantity'] });
      seen.add(k);
    });
  });

export const detailsSchema = z
  .array(httpUrl)
  .max(MAX_DETAILS)
  .superRefine((arr, ctx) => {
    if (new Set(arr).size !== arr.length) ctx.addIssue({ code: 'custom', message: 'Один и тот же файл добавлен дважды' });
  });

/** Для записи в БД: пустой массив → null. */
export function serializeJsonArray(arr: unknown[] | null | undefined): string | null {
  return arr && arr.length ? JSON.stringify(arr) : null;
}

/** Для чтения из БД: битые/пустые данные → [], без падения; мусорные элементы отбрасываются. */
export function parseQuantityVariants(raw: unknown): QuantityVariant[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: QuantityVariant[] = [];
    for (const it of arr) {
      const r = quantityVariantSchema.safeParse(it);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

/** Details из БД (Json) → массив URL. Битое/не массив → []; нестроки и не-http отбрасываются. */
export function parseDetails(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v.filter((u): u is string => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u));
}

/** Видео: до max ссылок http(s), без повторов, порядок сохраняется. */
const makeVideosSchema = (max: number) =>
  z
    .array(httpUrl)
    .max(max, `Не больше ${max} видео`)
    .superRefine((arr, ctx) => {
      if (new Set(arr).size !== arr.length) ctx.addIssue({ code: 'custom', message: 'Одно и то же видео добавлено дважды' });
    });
/** Видео товара — до 3. */
export const videosSchema = makeVideosSchema(MAX_VIDEOS);
/** Видео витрины — до 20. */
export const showcaseVideosSchema = makeVideosSchema(MAX_SHOWCASE_VIDEOS);

/** videos из БД → массив URL. Нет поля/битые данные → []; не-http и нестроки отбрасываются. */
export function parseVideos(raw: unknown, max: number = MAX_VIDEOS): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u)).slice(0, max);
}
