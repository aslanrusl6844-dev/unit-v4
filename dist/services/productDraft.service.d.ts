import { ProductDetails } from './productAgent.service';
import { Grid } from './sheetSplit.service';
export type TgUpdate = {
    update_id?: number;
    message?: {
        chat: {
            id: number;
        };
        from?: {
            id: number;
        };
        text?: string;
        caption?: string;
        photo?: Array<{
            file_id: string;
        }>;
        document?: {
            file_id: string;
            mime_type?: string;
        };
    };
    callback_query?: {
        id: string;
        data?: string;
        message?: {
            chat: {
                id: number;
            };
        };
    };
};
export declare function formatDraft(d: ProductDetails, price: number | null, oldPrice: number | null, revision: number): string;
/** «детали 1234567» / «детали <sku>» / «детали часть названия» → запрос поиска, иначе null. */
export declare function parseAttachCommand(text: string): string | null;
/**
 * Понимает обычную речь: «из этой картинки разъедини все фото на формат 1:1 и загрузи в детали по артикулу 2728897».
 * Артикул — отдельное 7-значное число. Режим: нарезка / как есть / спросить кнопками.
 */
export declare function inferIntent(text: string): {
    article: string;
    mode: 'slice' | 'raw' | 'ask';
    grid?: Grid;
} | null;
/** «нарезать 1234567 [2x5]» — один лист с несколькими слайдами режем на отдельные картинки. */
export declare function parseSliceCommand(text: string): {
    query: string;
    grid?: Grid;
} | null;
/** «картинки 1234567» — готовые картинки (например, из вашего ChatGPT) кладём в «Детали» как есть. */
export declare function parseRawCommand(text: string): string | null;
/** Адрес этого же сервера — по нему разносим генерацию сцен на отдельные вызовы (у каждого свои 60 с). */
export declare function setSelfBaseUrl(url: string): void;
/** Дочерний вызов: рисует одну сцену, кладёт в Blob, а последняя завершившаяся запускает сборку слайдов. */
export declare function handleSceneJob(draftId: string, index: number): Promise<void>;
/** Точка входа вебхука. Чужие чаты игнорируются молча. */
export declare function handleUpdate(update: TgUpdate): Promise<void>;
