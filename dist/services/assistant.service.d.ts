export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}
export interface CatalogItem {
    sku: string;
    name: string;
    category: string | null;
    subcategory: string | null;
    type: string | null;
    price: number | null;
    image: string | null;
    stock?: number | null;
    info?: string;
    /** Полный состав и характеристики — для «найденных товаров» в промпте. */
    details?: string;
    /** Витрины (бренды/магазины), в которых лежит товар. */
    showcases?: string[];
}
export interface ShowcaseInfo {
    id: string;
    title: string;
    type: string;
    description: string | null;
    count: number;
}
export interface Catalog {
    items: CatalogItem[];
    showcases: ShowcaseInfo[];
}
export declare const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
/** Ранжирование каталога по запросу (чистая функция — легко тестировать). */
export declare function rankProducts(items: CatalogItem[], query: string, limit?: number): CatalogItem[];
/** «На слух»: кириллица → латиница, повторы букв схлопнуты, только буквы и цифры. «Цель-29» и «CELL 29» дают одно: cel29. */
export declare function looseKey(s: string): string;
/** Витрины, названные в запросе (по границе слова, чтобы «9-9» не цеплялось за любое число). */
export declare function matchShowcases(showcases: ShowcaseInfo[], query: string): ShowcaseInfo[];
/** Достаём артикулы из маркеров {{артикул}} (формат приложения); {{витрина:id}} пропускаем. */
export declare function extractSkus(text: string): string[];
/** Артикулы из ответа инструмента (строки вида «- Название | артикул 123 | …»). */
export declare function skusFromToolResult(result: string): string[];
/**
 * Страховка: модель назвала товар из каталога, но забыла маркер {{артикул}} — тогда клиент видит текст
 * без фото. Ищем в ответе названия товаров (полностью или первые 3+ значимых слова) и возвращаем артикулы
 * без маркеров (не больше limit), чтобы дописать маркеры в конец ответа — приложение покажет карточки.
 */
export declare function missingProductSkus(text: string, items: CatalogItem[], limit?: number): string[];
/**
 * Страховка для кнопки «Смотреть все товары»: модель показала карточки, но забыла {{все:…}}.
 * Берём кандидатов (сначала из её поисков, потом из найденных по вопросу) того же подраздела,
 * что и показанные карточки, без уже показанных. Пусто — кнопки не будет.
 */
export declare function fallbackRelatedSkus(text: string, candidates: CatalogItem[], items: CatalogItem[], limit?: number): string[];
/** Если по словам ничего не нашлось — разнообразная выборка: по одному-два товара из каждого раздела. */
export declare function diverseSample(items: CatalogItem[], limit?: number): CatalogItem[];
export declare function loadCatalog(): Promise<Catalog>;
/** Строка товара для промпта и ответов инструментов. */
export declare function productLine(p: CatalogItem): string;
export declare function buildSystemPrompt(found: CatalogItem[], categories: string[], showcases?: ShowcaseInfo[]): string;
/** Стрим ответа Claude. onDelta вызывается с чистыми кусками текста. */
export declare function streamClaude(opts: {
    apiKey: string;
    model: string;
    system: string;
    messages: ChatMessage[];
    onDelta: (t: string) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    maxTokens?: number;
}): Promise<string>;
export declare const ASSISTANT_TOOLS: ({
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            showcase: {
                type: string;
                description: string;
            };
            query?: undefined;
            limit?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            query: {
                type: string;
            };
            limit: {
                type: string;
                description: string;
            };
            showcase?: undefined;
        };
        required: string[];
    };
})[];
/** Витрина по id, названию или «на слух». null — не нашли. */
export declare function findShowcase(showcases: ShowcaseInfo[], ref: string): ShowcaseInfo | null;
export declare function toolGetShowcase(catalog: Catalog, ref: string): string;
export declare function toolSearchProducts(catalog: Catalog, query: string, limit?: number): string;
export declare function runTool(catalog: Catalog, name: string, input: any): string;
/**
 * Ответ ассистента с инструментами: Claude может до maxRounds раз открыть витрину или поискать товары,
 * потом пишет ответ. Возвращает весь текст (для карточек товаров по маркерам {{артикул}}).
 */
export declare function runAssistant(opts: {
    apiKey: string;
    model: string;
    system: string;
    messages: ChatMessage[];
    catalog: Catalog;
    onDelta: (t: string) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    maxRounds?: number;
    maxTokens?: number;
    /** Каждый ответ инструмента (для подборки «Смотреть все товары»). */
    onToolResult?: (name: string, result: string) => void;
}): Promise<string>;
