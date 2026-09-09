import wbCommissionRatesRaw from '../data/wbCommissionRates.json';

/**
 * Справочник комиссий Wildberries по "предмету" (WB Subject) и схеме
 * продажи. Загружен из официальной таблицы тарифов WB (файл commission.xlsx,
 * загруженный пользователем 07.09.2026) — 7426 предметов, без выдумывания.
 *
 * Колонки в исходном файле:
 *   "Маркетплейс (FBS), %"  -> fbsPct  — продажа со своего склада (FBS)
 *   "Склад WB (FBW), %"     -> fbwPct  — продажа со склада WB (FBW)
 * (остальные колонки таблицы — C&C/DBW/EDBS — не используются, у нас нет
 * этих схем продажи в проекте).
 */

interface WbCommissionEntry {
  category: string;
  fbsPct: number | null;
  fbwPct: number | null;
}

const wbCommissionRates: Record<string, WbCommissionEntry> = wbCommissionRatesRaw as any;

export type WbScheme = 'FBS' | 'FBW';

/**
 * Точная ставка комиссии по предмету и схеме. Возвращает null, если
 * предмет не найден в справочнике ИЛИ для найденного предмета не заполнена
 * ставка по этой схеме — по требованию, мы НЕ подставляем выдуманное
 * число, а честно сигналим "нет данных" (интерфейс покажет "—").
 */
export function getWbCommissionRate(subject: string | undefined | null, scheme: WbScheme): number | null {
  if (!subject) return null;
  const entry = wbCommissionRates[subject];
  if (!entry) return null;
  const rate = scheme === 'FBS' ? entry.fbsPct : entry.fbwPct;
  return rate ?? null;
}

/** Есть ли такой предмет в справочнике вообще (для явного "предмет не найден"). */
export function isWbSubjectKnown(subject: string | undefined | null): boolean {
  if (!subject) return false;
  return subject in wbCommissionRates;
}

export function getWbCommissionCategory(subject: string | undefined | null): string | null {
  if (!subject) return null;
  return wbCommissionRates[subject]?.category ?? null;
}
