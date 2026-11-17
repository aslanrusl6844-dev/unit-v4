"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showcaseVideosSchema = exports.videosSchema = exports.detailsSchema = exports.quantityVariantsSchema = exports.quantityVariantSchema = exports.QUANTITY_UNITS = exports.MAX_SHOWCASE_VIDEOS = exports.MAX_VIDEOS = exports.MAX_DETAILS = exports.MAX_QUANTITY_VARIANTS = void 0;
exports.serializeJsonArray = serializeJsonArray;
exports.parseQuantityVariants = parseQuantityVariants;
exports.parseDetails = parseDetails;
exports.parseVideos = parseVideos;
const zod_1 = require("zod");
/**
 * Варианты количества (1/2/3/4 шт или кг, у каждого своя цена): JSON-строка в
 * Product.quantityVariants. «Детали» (фото/видео): массив URL в Product.details (Json).
 */
exports.MAX_QUANTITY_VARIANTS = 20;
exports.MAX_DETAILS = 10;
exports.MAX_VIDEOS = 3; // у товара
exports.MAX_SHOWCASE_VIDEOS = 20; // у витрины
exports.QUANTITY_UNITS = ['шт', 'кг'];
const httpUrl = zod_1.z
    .string()
    .trim()
    .max(2000)
    .refine((u) => /^https?:\/\/\S+$/i.test(u), 'url должен начинаться с http:// или https://');
exports.quantityVariantSchema = zod_1.z.object({
    quantity: zod_1.z.number().positive().max(100000),
    unit: zod_1.z.enum(exports.QUANTITY_UNITS).optional().default('шт'),
    price: zod_1.z.number().nonnegative().max(1e9),
});
exports.quantityVariantsSchema = zod_1.z
    .array(exports.quantityVariantSchema)
    .max(exports.MAX_QUANTITY_VARIANTS)
    .superRefine((arr, ctx) => {
    const seen = new Set();
    arr.forEach((v, i) => {
        const k = `${v.quantity}|${v.unit}`;
        if (seen.has(k))
            ctx.addIssue({ code: 'custom', message: `Вариант ${v.quantity} ${v.unit} повторяется`, path: [i, 'quantity'] });
        seen.add(k);
    });
});
exports.detailsSchema = zod_1.z
    .array(httpUrl)
    .max(exports.MAX_DETAILS)
    .superRefine((arr, ctx) => {
    if (new Set(arr).size !== arr.length)
        ctx.addIssue({ code: 'custom', message: 'Один и тот же файл добавлен дважды' });
});
/** Для записи в БД: пустой массив → null. */
function serializeJsonArray(arr) {
    return arr && arr.length ? JSON.stringify(arr) : null;
}
/** Для чтения из БД: битые/пустые данные → [], без падения; мусорные элементы отбрасываются. */
function parseQuantityVariants(raw) {
    if (typeof raw !== 'string' || !raw)
        return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            return [];
        const out = [];
        for (const it of arr) {
            const r = exports.quantityVariantSchema.safeParse(it);
            if (r.success)
                out.push(r.data);
        }
        return out;
    }
    catch {
        return [];
    }
}
/** Details из БД (Json) → массив URL. Битое/не массив → []; нестроки и не-http отбрасываются. */
function parseDetails(raw) {
    let v = raw;
    if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        }
        catch {
            return [];
        }
    }
    if (!Array.isArray(v))
        return [];
    return v.filter((u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u));
}
/** Видео: до max ссылок http(s), без повторов, порядок сохраняется. */
const makeVideosSchema = (max) => zod_1.z
    .array(httpUrl)
    .max(max, `Не больше ${max} видео`)
    .superRefine((arr, ctx) => {
    if (new Set(arr).size !== arr.length)
        ctx.addIssue({ code: 'custom', message: 'Одно и то же видео добавлено дважды' });
});
/** Видео товара — до 3. */
exports.videosSchema = makeVideosSchema(exports.MAX_VIDEOS);
/** Видео витрины — до 20. */
exports.showcaseVideosSchema = makeVideosSchema(exports.MAX_SHOWCASE_VIDEOS);
/** videos из БД → массив URL. Нет поля/битые данные → []; не-http и нестроки отбрасываются. */
function parseVideos(raw, max = exports.MAX_VIDEOS) {
    if (!Array.isArray(raw))
        return [];
    return raw.filter((u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u)).slice(0, max);
}
//# sourceMappingURL=productExtras.js.map