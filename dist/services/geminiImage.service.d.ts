export declare const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
export type RefImage = {
    data: Buffer;
    mime: string;
};
/** Определяет тип картинки по первым байтам (Telegram/Blob иногда отдают application/octet-stream). */
export declare function sniffImageMime(buf: Buffer, fallback?: string): string;
export declare function buildScenePrompt(scene: string): string;
/** Генерирует сцену с товаром через Gemini. Возвращает картинку или бросает ошибку. */
export declare function generateScene(opts: {
    apiKey: string;
    model?: string;
    refs: RefImage[];
    scene: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<RefImage>;
export declare const DEFAULT_OPENAI_MODEL = "gpt-image-1";
/** Рисует сцену через OpenAI Images (edits с референсными фото товара). */
export declare function generateSceneOpenAI(opts: {
    apiKey: string;
    model?: string;
    refs: RefImage[];
    scene: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<RefImage>;
/**
 * Выбор сервиса: IMAGE_PROVIDER=openai|gemini (по умолчанию — Gemini, если есть ключ, иначе OpenAI).
 * Если основной сервис ответил ошибкой и есть ключ второго — пробуем второй.
 */
export declare function generateSceneAuto(opts: {
    refs: RefImage[];
    scene: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<RefImage>;
