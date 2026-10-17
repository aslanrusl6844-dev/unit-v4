import { z } from 'zod';

/**
 * Варианты количества (1/2/3/4 шт или кг, у каждого своя цена) и рич-контент
 * «Детали» (фото, сертификаты, видео). Хранятся JSON-строкой в колонках
 * Product.quantityVariants / Product.details (как Product.images).
 */
export const MAX_QUANTITY_VARIANTS = 20;
export const MAX_DETAILS = 100;
export const QUANTITY_UNITS = ['шт', 'кг'] as const;
export const DETAIL_TYPES = ['photo', 'certificate', 'video'] as const;

export type QuantityVariant = { quantity: number; unit: (typeof QUANTITY_UNITS)[number]; price: number };
export type ProductDetail = { type: (typeof DETAIL_TYPES)[number]; url: string };

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

export const detailSchema = z.object({ type: z.enum(DETAIL_TYPES), url: httpUrl });
export const detailsSchema = z.array(detailSchema).max(MAX_DETAILS);

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

export function parseDetails(raw: unknown): ProductDetail[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: ProductDetail[] = [];
    for (const it of arr) {
      const r = detailSchema.safeParse(it);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}
