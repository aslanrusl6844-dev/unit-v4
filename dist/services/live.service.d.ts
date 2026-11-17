/** App ID проекта Agora не секрет (он и так есть в приложении); сертификат — только в переменных Vercel. */
export declare const AGORA_APP_ID: string;
export declare const agoraConfigured: () => boolean;
/** Эфир без отметки креатора дольше этого — считается завершённым (приложение закрыли, пропала сеть). */
export declare const LIVE_STALE_MS = 90000;
export declare const TOKEN_TTL_S: number;
export declare const MAX_SKUS = 10;
export declare function agoraToken(channel: string, role: 'host' | 'audience'): string;
export declare function newChannel(): string;
export declare function cleanSkus(raw: unknown): string[];
export declare function parseSkus(raw: string | null | undefined): string[];
type StreamRow = {
    status: string;
    lastBeatAt?: Date | null;
    startedAt?: Date | null;
};
/** Эфир действительно идёт: статус live и креатор недавно отмечался. */
export declare function isOnAir(s: StreamRow, now?: number): boolean;
/** Активный креатор по телефону (или null). */
export declare function activeCreatorByPhone(phone: string): Promise<{
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
/** Закрывает «зависшие» эфиры (креатор пропал) — вызывается при чтении списков. Запись тоже останавливаем. */
export declare function closeStaleStreams(now?: number): Promise<void>;
export declare function videoDto(v: any, creatorName: string, liked?: boolean): {
    id: any;
    title: any;
    videoUrl: any;
    skus: string[];
    likes: any;
    views: any;
    status: any;
    creatorName: string;
    liked: boolean;
    createdAt: any;
};
export declare function streamDto(s: any, creatorName: string): {
    id: any;
    title: any;
    status: any;
    skus: string[];
    scheduledAt: any;
    startedAt: any;
    endedAt: any;
    creatorName: string;
    replayUrl: any;
    likes: any;
    views: any;
    viewers: number;
};
/** Имена креаторов одним запросом. */
export declare function creatorNames(ids: string[]): Promise<Map<string, string>>;
export type LiveCat = {
    id: string;
    title: string;
    categories: string[];
};
export declare function activeLiveCategories(): Promise<LiveCat[]>;
/** Раздел каталога для каждого артикула (артикул витрины или sku). */
export declare function shopCategoryBySku(skus: string[]): Promise<Map<string, string>>;
/** id вкладок, в которые попадает набор товаров. */
export declare function catsFor(skus: string[], bySku: Map<string, string>, cats: LiveCat[]): string[];
export declare const RECORDER_UID = "999";
export declare function recordingConfigured(): boolean;
type FetchLike = typeof fetch;
/** Для тестов. */
export declare function setRecordingFetch(f: FetchLike): void;
/** Папка записи эфира в R2 (Agora разрешает только латиницу и цифры). */
export declare const replayPrefix: (streamId: string) => string[];
/** Запустить запись эфира. Ошибка не мешает эфиру — просто не будет повтора. */
export declare function startRecording(stream: {
    id: string;
    channel: string;
}): Promise<void>;
/** Остановить запись (если шла). Файлы Agora догружает в R2 сама; ссылку найдём по папке. */
export declare function stopRecording(stream: {
    id: string;
    channel: string;
    recResourceId?: string | null;
    recSid?: string | null;
    recState?: string | null;
}): Promise<void>;
/** Для завершённых эфиров без ссылки на повтор — ищем mp4 в папке записи в R2. */
export declare function resolveReplays(limit?: number): Promise<void>;
export declare function viewersOf(channel: string): Promise<number>;
/** Покупатели с «колокольчиком» на этого креатора получают пуш: эфир начался. */
export declare function notifyFollowers(stream: {
    id: string;
    creatorId: string;
    title: string;
}, creatorName: string): Promise<number>;
export declare function bannerDto(b: any): {
    id: any;
    imageUrl: any;
    title: any;
    linkType: any;
    linkValue: any;
};
export {};
