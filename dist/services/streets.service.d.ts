/** Ключ для поиска: нижний регистр, ё→е, без слов «улица/проспект…», без знаков. */
export declare function streetKey(name: string): string;
export interface OverpassResponse {
    elements?: Array<{
        tags?: Record<string, string>;
    }>;
}
/** Названия из ответа Overpass: без повторов, мусора и чисто цифровых имён. */
export declare function parseOverpassNames(json: OverpassResponse): string[];
/** Центр города и полуразмер прямоугольника (градусы широты/долготы). Прямоугольник — лёгкий запрос
 *  для серверов карты (поиск по границам города они не успевали). Может захватить пригородные посёлки. */
export declare const CITY_BBOX: Record<string, [lat: number, lon: number, dLat: number, dLon: number]>;
export declare function buildOverpassQuery(city: string): string;
/** Скачивает названия улиц города из OpenStreetMap: опрашивает все зеркала сразу, берёт первый удачный ответ. */
export declare function fetchCityStreets(city: string, fetchImpl?: typeof fetch): Promise<string[]>;
/** Заменяет улицы города новым списком. Пустой список не записываем — чтобы сбой не стёр старые данные. */
export declare function saveCityStreets(city: string, names: string[]): Promise<number>;
export interface StreetRow {
    name: string;
    key: string;
}
/** Порядок подсказок: сначала начинающиеся с введённого, потом слова внутри названия, потом остальные. */
export declare function rankStreets(rows: StreetRow[], query: string, limit?: number): string[];
export declare function searchStreets(city: string, query: string, limit?: number): Promise<string[]>;
