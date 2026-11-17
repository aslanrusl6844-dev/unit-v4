export declare const CREATOR_MIN_PERCENT = 1;
export declare const CREATOR_MAX_PERCENT = 50;
export declare const CREATOR_DEFAULT_PERCENT = 7;
/** Процент креатора: число 1..50 (до 0.5), иначе null. */
export declare function normalizePercent(raw: unknown): number | null;
export declare function randomCreatorCode(): string;
export declare function uniqueCreatorCode(): Promise<string>;
export declare function parseAnswers(raw: string | null | undefined): Record<string, unknown>;
/** Пуш покупателю-креатору (по телефону). Ошибки не мешают основному действию. */
export declare function pushCreator(phone: string, title: string, body: string): Promise<void>;
/** Одобрить заявку: создаёт (или обновляет) креатора с процентом и личным кодом. */
export declare function approveApplication(id: string, percent: number): Promise<{
    code: string;
    name: string;
    id: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
    phone: string;
    percent: number;
    autoPublish: boolean;
    applicationId: string | null;
} | null>;
