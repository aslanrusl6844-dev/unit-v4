export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';

export type RefImage = { data: Buffer; mime: string };

/** Определяет тип картинки по первым байтам (Telegram/Blob иногда отдают application/octet-stream). */
export function sniffImageMime(buf: Buffer, fallback = 'image/jpeg'): string {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return fallback;
}

export function buildScenePrompt(scene: string): string {
  return [
    'Edit/compose a premium e-commerce product photograph for a marketplace detail page, vertical 3:4.',
    'Use the product from the reference photo EXACTLY as it is: same shape, packaging, colors, label and all text printed on the package must remain unchanged and readable. Do not redesign, do not alter the brand name.',
    `Scene: ${scene}.`,
    'Place the product in the upper two thirds of the frame; keep the bottom 35% calm and uncluttered (soft, not busy) because text will be added there.',
    'Do NOT add any extra text, letters, numbers, logos, watermarks, price tags or people.',
  ].join(' ');
}

/** Генерирует сцену с товаром через Gemini. Возвращает картинку или бросает ошибку. */
export async function generateScene(opts: {
  apiKey: string;
  model?: string;
  refs: RefImage[];
  scene: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RefImage> {
  const f = opts.fetchImpl ?? fetch;
  const model = opts.model || DEFAULT_IMAGE_MODEL;
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: buildScenePrompt(opts.scene) },
          ...opts.refs.slice(0, 3).map((r) => ({ inline_data: { mime_type: sniffImageMime(r.data), data: r.data.toString('base64') } })),
        ],
      }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 40_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`);
  const body: any = await res.json();
  const parts: any[] = body?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  if (!img) throw new Error('Gemini не вернул картинку' + (body?.candidates?.[0]?.finishReason ? ` (${body.candidates[0].finishReason})` : ''));
  const d = img.inlineData ?? img.inline_data;
  return { data: Buffer.from(d.data, 'base64'), mime: d.mimeType ?? d.mime_type ?? 'image/png' };
}

export const DEFAULT_OPENAI_MODEL = 'gpt-image-1';

/** Рисует сцену через OpenAI Images (edits с референсными фото товара). */
export async function generateSceneOpenAI(opts: {
  apiKey: string;
  model?: string;
  refs: RefImage[];
  scene: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RefImage> {
  const f = opts.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('model', opts.model || DEFAULT_OPENAI_MODEL);
  form.append('prompt', buildScenePrompt(opts.scene));
  form.append('size', '1024x1536');
  form.append('quality', 'medium');
  form.append('n', '1');
  opts.refs.slice(0, 3).forEach((r, i) => {
    const mime = sniffImageMime(r.data);
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    form.append('image[]', new Blob([new Uint8Array(r.data)], { type: mime }), `ref${i}.${ext}`);
  });
  const res = await f('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 50_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 400)}`);
  const body: any = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI не вернул картинку');
  return { data: Buffer.from(b64, 'base64'), mime: 'image/png' };
}

/**
 * Выбор сервиса: IMAGE_PROVIDER=openai|gemini (по умолчанию — Gemini, если есть ключ, иначе OpenAI).
 * Если основной сервис ответил ошибкой и есть ключ второго — пробуем второй.
 */
export async function generateSceneAuto(opts: { refs: RefImage[]; scene: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<RefImage> {
  const e = opts.env ?? process.env;
  const gem = e.GEMINI_API_KEY ? () => generateScene({ apiKey: e.GEMINI_API_KEY!, model: e.GEMINI_IMAGE_MODEL, refs: opts.refs, scene: opts.scene, timeoutMs: 45_000, fetchImpl: opts.fetchImpl }) : null;
  const oai = e.OPENAI_API_KEY ? () => generateSceneOpenAI({ apiKey: e.OPENAI_API_KEY!, model: e.OPENAI_IMAGE_MODEL, refs: opts.refs, scene: opts.scene, timeoutMs: 50_000, fetchImpl: opts.fetchImpl }) : null;
  const order = (e.IMAGE_PROVIDER === 'openai' ? [oai, gem] : [gem, oai]).filter(Boolean) as Array<() => Promise<RefImage>>;
  if (!order.length) throw new Error('нет ключей GEMINI_API_KEY / OPENAI_API_KEY');
  const errors: string[] = [];
  for (const run of order) {
    try { return await run(); } catch (err: any) { errors.push(String(err?.message ?? err)); }
  }
  throw new Error(errors.join(' || '));
}
