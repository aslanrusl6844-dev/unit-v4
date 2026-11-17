/** Регионы Яндекса (geo id). Список можно расширять по справочнику регионов Яндекса. */
export declare const WORDSTAT_REGIONS: Record<string, {
    id: string;
    label: string;
}>;
export interface WordstatPhrase {
    phrase: string;
    count: number;
}
export interface WordstatTopResult {
    phrase: string;
    regionLabel: string;
    total: number | null;
    top: WordstatPhrase[];
    associations: WordstatPhrase[];
}
/**
 * Разбор ответа topRequests. Поля Яндекса: results (запросы со словом) и
 * associations (похожие запросы), count приходит строкой. Разбор терпимый:
 * незнакомый формат даёт пустые списки, а не падение.
 */
export declare function mapWordstatTop(json: any, phrase: string, regionLabel: string): WordstatTopResult;
export declare function getWordstatTop(phrase: string, geo: string, numPhrases?: number): Promise<WordstatTopResult>;
