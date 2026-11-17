export type WbScheme = 'FBS' | 'FBW';
/**
 * Точная ставка комиссии по предмету и схеме. Возвращает null, если
 * предмет не найден в справочнике ИЛИ для найденного предмета не заполнена
 * ставка по этой схеме — по требованию, мы НЕ подставляем выдуманное
 * число, а честно сигналим "нет данных" (интерфейс покажет "—").
 */
export declare function getWbCommissionRate(subject: string | undefined | null, scheme: WbScheme): number | null;
/** Есть ли такой предмет в справочнике вообще (для явного "предмет не найден"). */
export declare function isWbSubjectKnown(subject: string | undefined | null): boolean;
export declare function getWbCommissionCategory(subject: string | undefined | null): string | null;
