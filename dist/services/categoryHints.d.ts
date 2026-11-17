/**
 * Подсказка category / type My Market по НАЗВАНИЮ товара. Это подсказка, а не
 * публикация: сам по себе результат ничего не включает в продажу и никогда не
 * затирает то, что уже заполнено. Дерево категорий Ozon здесь не используется —
 * только справочник My Market ниже.
 *
 * Как расширять: добавьте объект в HINT_RULES.
 *   match    — регулярное выражение по названию (нижний регистр, «ё» → «е»);
 *   exclude  — если совпало, правило не срабатывает (например «джинсовая куртка»);
 *   type     — тип My Market;
 *   category — строка ИЛИ { female, male } — категория зависит от слов
 *              «женск…»/«мужск…» в названии;
 *   weak     — «слабое» правило: само подсказку не создаёт, но, если рядом
 *              сработало обычное правило с ДРУГИМ типом, делает название
 *              спорным (пример: «шампунь-гель» — шампунь + слабое «гель»).
 */
export interface CategoryVariant {
    category: string;
    type: string;
}
type Gendered = {
    female: string;
    male: string;
};
interface HintRule {
    match: RegExp;
    exclude?: RegExp;
    type: string;
    category: string | Gendered;
    weak?: boolean;
}
export declare const HINT_RULES: HintRule[];
export type HintStatus = 'none' | 'single' | 'multiple';
export interface HintResult {
    status: HintStatus;
    /** single — ровно один вариант (его можно ставить автоматически);
     *  multiple — 2–3 варианта, автоматически НЕ ставится; none — пусто. */
    variants: CategoryVariant[];
}
/** Подсказка по названию. Не обращается ни к базе, ни к сети. */
export declare function hintCategoryByName(rawName: string | null | undefined): HintResult;
export interface CatalogCategory {
    category: string;
    types: string[];
}
/**
 * Стартовый список типов по категориям (расширяемый): попадает в выпадающий
 * список «Тип» в карточке независимо от того, есть ли уже товары с таким типом.
 * Свои типы, вписанные в карточке, добавляются к нему автоматически (таблица
 * ShopCategoryType). Подкатегория тип не заменяет и не дублирует.
 */
export declare const STARTER_CATALOG: CatalogCategory[];
export declare function starterCatalogPairs(): CategoryVariant[];
/** Все пары category/type, которые знает справочник правил. */
export declare function hintRuleCatalogPairs(): CategoryVariant[];
/** Собирает каталог «категория → её типы» из любых пар; без дублей, по алфавиту. */
export declare function buildCatalog(pairs: Array<{
    category: string | null | undefined;
    type: string | null | undefined;
}>): CatalogCategory[];
export {};
