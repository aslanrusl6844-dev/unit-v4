import { z } from 'zod';
import { SHOP_CATEGORIES } from '../config/shopCategories';

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5';

export const detailsSchema = z.object({
  name: z.string().min(2).max(200),
  category: z.string().refine((c) => SHOP_CATEGORIES.includes(c), 'категория не из списка разделов'),
  subcategory: z.string().max(100).nullable().optional(),
  type: z.string().min(1).max(100),
  description: z.string().max(1500),
  composition: z.string().max(1500).nullable().optional(),
  characteristics: z.array(z.object({ name: z.string().max(80), value: z.string().max(300) })).max(14).default([]),
  usage: z.string().max(900).nullable().optional(),
  scenes: z.array(z.object({ headline: z.string().max(50), caption: z.string().max(110), prompt: z.string().max(400) })).max(6).default([]), // сцены для нейросети
  features: z.array(z.string().max(120)).max(8).default([]), // продающие тезисы для инфографики (следующий этап)
  notFound: z.array(z.string().max(160)).max(10).default([]),
  questions: z.array(z.string().max(200)).max(5).default([]),
});
export type ProductDetails = z.infer<typeof detailsSchema>;

/** Достаёт JSON-объект из ответа модели (с ```json``` или без). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('в ответе нет JSON');
  return JSON.parse(body.slice(start, end + 1));
}

/** «4500 / 6000», «цена 4 500 старая 6 000» → { price, oldPrice }. */
export function parsePrices(text: string): { price?: number; oldPrice?: number } {
  const t = text.replace(/(\d)[  ](?=\d{3}(?!\d))/g, '$1');
  const nums = (t.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.'))).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return {};
  const price = nums[0];
  const oldPrice = nums[1] !== undefined && nums[1] > price ? nums[1] : undefined;
  return { price, oldPrice };
}

export function buildDetailsPrompt(taxonomy: string): string {
  return `Ты — товаровед магазина My Market (Казахстан). По фото товара (упаковка, этикетки, состав, надписи) составь карточку.
СТРОГИЕ ПРАВИЛА:
- Бери данные ТОЛЬКО с фото и из подписи владельца. Состав, объём, срок годности, страну, бренд не выдумывай: нет на фото — ставь null и добавь пункт в "notFound".
- "category" — РОВНО одно значение из списка: ${SHOP_CATEGORIES.join('; ')}.
- "subcategory" и "type" — коротко, по-русски. Уже используемые в каталоге (предпочитай их, новые только если ничего не подходит):
${taxonomy || '(пока пусто)'}
- "name" — как продаётся: бренд + что это + объём/размер (если видно). Без капса и эмодзи.
- "description" — 2–4 предложения для покупателя, без обещаний лечения и «лучший в мире».
- "features" — 3–6 коротких продающих тезисов, только то, что подтверждено фото/описанием.
- "scenes" — 4–6 РАЗНЫХ сцен для красивых картинок «rich content» (как у Pinduoduo/Coupang). Для каждой: "headline" (до 6 слов, продающий заголовок), "caption" (1 короткая строка), "prompt" — описание фона/сцены НА АНГЛИЙСКОМ (место, свет, реквизит, ракурс), без текста на картинке и без выдуманных свойств товара. Сцены должны отличаться друг от друга: 1) героическая — товар на красивом фоне по категории; 2) крупный план упаковки/текстуры; 3) другой ракурс на цветном студийном фоне; 4) ситуация использования (без людей); 5) ингредиенты или материалы вокруг товара (только если подтверждено фото); 6) подарочная/лайфстайл подача.
- "usage" — способ применения/хранения, ТОЛЬКО если написан на упаковке, иначе null.
- "questions" — что нужно уточнить у владельца (если что-то критичное неясно).
Верни ТОЛЬКО JSON без пояснений:
{"name":"","category":"","subcategory":null,"type":"","description":"","composition":null,"usage":null,"scenes":[{"headline":"","caption":"","prompt":""}],"characteristics":[{"name":"","value":""}],"features":[],"notFound":[],"questions":[]}`;
}

export async function runDetailsAgent(opts: {
  apiKey: string;
  model?: string;
  photos: string[];
  notes?: string | null;
  price?: number | null;
  oldPrice?: number | null;
  taxonomy: string;
  feedback?: string | null;
  previous?: ProductDetails | null;
  fetchImpl?: typeof fetch;
}): Promise<ProductDetails> {
  const f = opts.fetchImpl ?? fetch;
  const content: any[] = opts.photos.slice(0, 8).map((url) => ({ type: 'image', source: { type: 'url', url } }));
  const lines = [
    opts.notes ? `Подпись владельца: ${opts.notes}` : '',
    opts.price ? `Цена: ${opts.price} ₸${opts.oldPrice ? `, старая цена ${opts.oldPrice} ₸` : ''}` : '',
    opts.previous ? `Предыдущий вариант карточки: ${JSON.stringify(opts.previous)}` : '',
    opts.feedback ? `ВЛАДЕЛЕЦ ПРОСИТ ИСПРАВИТЬ: ${opts.feedback}. Учти это и верни обновлённую карточку.` : '',
    'Составь карточку.',
  ].filter(Boolean);
  content.push({ type: 'text', text: lines.join('\n') });

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: opts.model || DEFAULT_AGENT_MODEL,
        max_tokens: 2800,
        system: buildDetailsPrompt(opts.taxonomy),
        messages: [{ role: 'user', content: attempt ? [...content, { type: 'text', text: `Прошлый ответ не прошёл проверку: ${lastError}. Исправь и верни только JSON.` }] : content }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body: any = await res.json();
    const text = (body.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    try {
      return detailsSchema.parse(extractJson(text));
    } catch (e: any) {
      lastError = String(e?.message ?? e).slice(0, 300);
    }
  }
  throw new Error('Модель не вернула корректную карточку: ' + lastError);
}
