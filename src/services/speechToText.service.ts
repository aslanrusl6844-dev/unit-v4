/**
 * Голосовые сообщения Баурсаку: аудио → текст. Новых ключей не нужно — берём то, что уже есть на сервере:
 * сначала Gemini (GEMINI_API_KEY, хорошо понимает русский и казахский), если не вышло — OpenAI (OPENAI_API_KEY).
 * STT_PROVIDER=openai|gemini переставляет порядок.
 */
export const DEFAULT_GEMINI_STT_MODEL = 'gemini-2.5-flash';
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

async function geminiStt(opts: { apiKey: string; audio: Buffer; mime: string; model?: string; fetchImpl?: typeof fetch }): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const model = opts.model || DEFAULT_GEMINI_STT_MODEL;
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: opts.mime, data: opts.audio.toString('base64') } }] }],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const body: any = await res.json();
  const parts: any[] = body?.candidates?.[0]?.content?.parts ?? [];
  return cleanTranscript(parts.map((p) => p?.text ?? '').join(' '));
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
