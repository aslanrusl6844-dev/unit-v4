export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';

export type RefImage = { data: Buffer; mime: string };

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
          ...opts.refs.slice(0, 3).map((r) => ({ inline_data: { mime_type: r.mime, data: r.data.toString('base64') } })),
        ],
      }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 40_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const body: any = await res.json();
  const parts: any[] = body?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  if (!img) throw new Error('Gemini не вернул картинку' + (body?.candidates?.[0]?.finishReason ? ` (${body.candidates[0].finishReason})` : ''));
  const d = img.inlineData ?? img.inline_data;
  return { data: Buffer.from(d.data, 'base64'), mime: d.mimeType ?? d.mime_type ?? 'image/png' };
}
