/**
 * Голосовые сообщения Баурсаку: аудио → текст. Новых ключей не нужно — берём то, что уже есть на сервере:
 * сначала Gemini (GEMINI_API_KEY, хорошо понимает русский и казахский), если не вышло — OpenAI (OPENAI_API_KEY).
 * STT_PROVIDER=openai|gemini переставляет порядок.
 */
export const DEFAULT_GEMINI_STT_MODEL = 'gemini-3.5-flash-lite'; // лёгкая и быстрая: для расшифровки речи «думать» не нужно
// Старые модели Google отключает для новых проектов (404) — при 404 пробуем следующую по списку.
export const GEMINI_STT_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-flash-latest'];
export const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe';
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // у Vercel лимит тела запроса ~4,5 МБ

const PROMPT = 'Расшифруй голосовое сообщение клиента магазина дословно, на том языке, на котором он говорит (русский или казахский). '
  + 'Верни ТОЛЬКО текст сообщения, без пояснений и кавычек. Если речи нет или она неразборчива — верни пустую строку.';

export function cleanTranscript(s: unknown): string {
  return String(s ?? '').replace(/^["«»“”\s]+|["«»“”\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 1500);
}

export function audioMime(contentType: string | undefined): string {
  const m = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return m.startsWith('audio/') || m === 'video/mp4' ? m : 'audio/mp4';
}

async function geminiSttOne(opts: { apiKey: string; audio: Buffer; mime: string; model: string; fetchImpl?: typeof fetch }): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: opts.mime, data: opts.audio.toString('base64') } }] }],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw Object.assign(new Error(`Gemini ${opts.model} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`), { status: res.status });
  const body: any = await res.json();
  const parts: any[] = body?.candidates?.[0]?.content?.parts ?? [];
  return cleanTranscript(parts.map((p) => p?.text ?? '').join(' '));
}

async function geminiStt(opts: { apiKey: string; audio: Buffer; mime: string; model?: string; fetchImpl?: typeof fetch }): Promise<string> {
  const models = [...new Set([opts.model || DEFAULT_GEMINI_STT_MODEL, ...GEMINI_STT_FALLBACK_MODELS])];
  const errors: string[] = [];
  for (const [i, model] of models.entries()) {
    try {
      try {
        return await geminiSttOne({ ...opts, model });
      } catch (e: any) {
        if (i > 0 || Number(e?.status) !== 503) throw e; // повтор — только у первой модели, чтобы уложиться во время функции
        await new Promise((r) => setTimeout(r, 800)); // «высокий спрос» часто проходит за секунду — один повтор
        return await geminiSttOne({ ...opts, model });
      }
    } catch (e: any) {
      errors.push(String(e?.message ?? e));
      // 404 (модель отключена), 429 (лимит) и 5xx (перегрузка) — у каждой модели своя очередь, пробуем следующую.
      // 400/401/403 — проблема в запросе или ключе, другая модель не поможет.
      const st = Number(e?.status);
      if (!(st === 404 || st === 429 || st >= 500 || Number.isNaN(st))) break;
    }
  }
  throw new Error(errors.join(' ; '));
}

async function openaiStt(opts: { apiKey: string; audio: Buffer; mime: string; model?: string; fetchImpl?: typeof fetch }): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const form = new FormData();
  const ext = opts.mime.includes('ogg') ? 'ogg' : opts.mime.includes('webm') ? 'webm' : opts.mime.includes('mpeg') ? 'mp3' : 'm4a';
  form.append('file', new Blob([new Uint8Array(opts.audio)], { type: opts.mime }), `voice.${ext}`);
  form.append('model', opts.model || DEFAULT_OPENAI_STT_MODEL);
  form.append('prompt', 'Голосовое сообщение клиенту магазина. Русский или казахский язык.');
  const res = await f('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${opts.apiKey}` }, body: form, signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const body: any = await res.json();
  return cleanTranscript(body?.text);
}

/** Текст голосового сообщения. Пустая строка — речи не услышали. Все провайдеры упали — ошибка. */
export async function transcribeAudio(opts: {
  audio: Buffer; mime: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}): Promise<string> {
  const env = opts.env ?? process.env;
  const providers: Array<'gemini' | 'openai'> = env.STT_PROVIDER === 'openai' ? ['openai', 'gemini'] : ['gemini', 'openai'];
  const errors: string[] = [];
  for (const p of providers) {
    const apiKey = p === 'gemini' ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;
    if (!apiKey) continue;
    try {
      const args = { apiKey, audio: opts.audio, mime: opts.mime, fetchImpl: opts.fetchImpl };
      return p === 'gemini'
        ? await geminiStt({ ...args, model: env.STT_GEMINI_MODEL })
        : await openaiStt({ ...args, model: env.STT_OPENAI_MODEL });
    } catch (e: any) {
      errors.push(String(e?.message ?? e));
    }
  }
  throw new Error(errors.length ? errors.join(' | ') : 'Нет ключей GEMINI_API_KEY / OPENAI_API_KEY для распознавания речи');
}
