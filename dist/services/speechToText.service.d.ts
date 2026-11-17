/**
 * Голосовые сообщения Баурсаку: аудио → текст. Новых ключей не нужно — берём то, что уже есть на сервере:
 * сначала Gemini (GEMINI_API_KEY, хорошо понимает русский и казахский), если не вышло — OpenAI (OPENAI_API_KEY).
 * STT_PROVIDER=openai|gemini переставляет порядок.
 */
export declare const DEFAULT_GEMINI_STT_MODEL = "gemini-3.5-flash-lite";
export declare const GEMINI_STT_FALLBACK_MODELS: string[];
export declare const DEFAULT_OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
export declare const MAX_AUDIO_BYTES: number;
/** Язык интерфейса приложения (ru/kk/en/…) — только подсказка: говорить клиент может на любом языке. */
export declare function sttPrompt(lang?: string | null): string;
export declare function cleanTranscript(s: unknown): string;
export declare function audioMime(contentType: string | undefined): string;
/** Текст голосового сообщения. Пустая строка — речи не услышали. Все провайдеры упали — ошибка. */
export declare function transcribeAudio(opts: {
    audio: Buffer;
    mime: string;
    lang?: string | null;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<string>;
