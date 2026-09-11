import kaspiCategoryTariffsRaw from '../data/kaspiCategoryTariffs.json';

/**
 * Справочник комиссий Kaspi.kz — ПОЛНАЯ официальная таблица тарифов,
 * загружена из PDF пользователя (45 страниц, 4113 строк с категориями
 * 1–5 уровня и ставками без/с НДС). Используется колонка "Комиссия с НДС"
 * — именно её реально платит продавец.
 *
 * Источник: src/data/kaspiCategoryTariffs.json — { "Название leaf-категории
 * (5-й уровень)": { topCategory, ratePct } }, сгенерирован из PDF через
 * pdfplumber. Ничего не досочинено сверх того, что реально есть в файле —
 * если категории нет в этом справочнике, комиссия НЕ считается по точной
 * ставке (используется безопасный дефолт, см. ниже).
 */

interface KaspiCategoryTariffEntry {
  topCategory: string;
  ratePct: number;
}

const kaspiCategoryTariffs: Record<string, KaspiCategoryTariffEntry> = kaspiCategoryTariffsRaw as any;

// Дефолт — если вообще ничего не известно о категории товара. Посчитан по
// реальным данным: 3881 из 4126 строк таблицы (94%) используют именно эту
// ставку — самая распространённая на площадке, безопасный выбор "по умолчанию".
export const KASPI_RATE_DEFAULT = 12.5;

// Доминирующая (самая частая) ставка по каждой категории 1-го уровня —
// используется, когда известна ТОЛЬКО верхняя категория товара, без точной
// leaf-категории (5-го уровня). Посчитано из тех же 4126 строк реальной
// таблицы (мода — не выдумано вручную).
export const KASPI_TOP_CATEGORY_RATE: Record<string, number> = {
  'Автотовары': 12.5,
  'Аксессуары': 15.5,
  'Аптека': 12.5,
  'Бытовая техника': 12.5,
  'Детские товары': 12.5,
  'Досуг, книги': 12.5,
  'Канцелярские товары': 12.5,
  'Компьютеры': 12.5,
  'Красота и здоровье': 12.5,
  'Мебель': 12.5,
  'Обувь': 12.5,
  'Одежда': 12.5,
  'Подарки, товары для праздников': 12.5,
  'Продукты питания': 7.3,
  'Спорт, туризм': 12.5,
  'Строительство, ремонт': 12.5,
  'ТВ, Аудио, Видео': 12.5,
  'Телефоны и гаджеты': 12.5,
  'Товары для дома и дачи': 12.5,
  'Товары для животных': 12.5,
  'Украшения': 15.5,
};

export interface KaspiCommissionInput {
  topCategory: string; // Категория 1-го уровня, как в карточке Kaspi
  leafCategory?: string; // Самая точная категория товара (5-й уровень, как в полном справочнике)
}

/**
 * Возвращает комиссию Kaspi (С УЧЁТОМ НДС, в %) для товара по его категории.
 * Приоритет:
 *   1) Точное совпадение leaf-категории в ПОЛНОЙ таблице (4113 категорий) —
 *      самый точный вариант, покрывает практически весь ассортимент Kaspi.
 *   2) Доминирующая ставка по категории 1-го уровня (если leaf неизвестен
 *      или не нашёлся в таблице).
 *   3) Безопасный дефолт 12.5% (самая частая ставка на площадке) — так
 *      комиссия НИКОГДА не считается нулевой, даже без единой известной категории.
 */
export function getKaspiCommissionRate(input: KaspiCommissionInput): number {
  const { topCategory, leafCategory } = input;

  if (leafCategory && leafCategory in kaspiCategoryTariffs) {
    return kaspiCategoryTariffs[leafCategory].ratePct;
  }

  if (topCategory in KASPI_TOP_CATEGORY_RATE) {
    return KASPI_TOP_CATEGORY_RATE[topCategory];
  }

  return KASPI_RATE_DEFAULT; // безопасный дефолт — комиссия никогда не 0
}

/**
 * Сумма комиссии в тенге для конкретной продажи. Ставка из
 * getKaspiCommissionRate() — это уже готовая ставка С НДС.
 */
export function calcKaspiCommissionAmount(revenue: number, input: KaspiCommissionInput): number {
  const rate = getKaspiCommissionRate(input);
  return Math.round((revenue * rate) / 100 * 100) / 100;
}

export interface KaspiCategoryOption {
  name: string;
  ratePct: number;
  level: 'top' | 'leaf'; // top — категория 1-го уровня (кладём в kaspiTopCategory); leaf — точная подкатегория из полной таблицы (кладём в kaspiLeafCategory)
  topCategory?: string; // для leaf — к какому верхнему разделу относится (показываем в подсказке)
}

/**
 * ПОЛНЫЙ список всех категорий Kaspi из официальной таблицы тарифов —
 * 4113 точных (5-го уровня) + 21 верхнего уровня. Ничего не выдумано —
 * ровно то, что есть в PDF пользователя, плюс безопасные дефолты по
 * верхним разделам (посчитаны как мода по реальным данным, не вручную).
 */
export function getAllKaspiCategoriesWithRates(): KaspiCategoryOption[] {
  const result: KaspiCategoryOption[] = [];
  for (const [name, ratePct] of Object.entries(KASPI_TOP_CATEGORY_RATE)) {
    result.push({ name, ratePct, level: 'top' });
  }
  for (const [name, entry] of Object.entries(kaspiCategoryTariffs)) {
    result.push({ name, ratePct: entry.ratePct, level: 'leaf', topCategory: entry.topCategory });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
