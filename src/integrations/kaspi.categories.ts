/**
 * Справочник комиссий "Магазин на Kaspi.kz" по категориям.
 * Источник: официальная таблица комиссий Kaspi (актуализирована по данным
 * пользователя — тарифы С УЧЁТОМ НДС, "вторая колонка" официальной таблицы,
 * именно её реально платит продавец).
 *
 * ВАЖНО: в отличие от предыдущей версии этого файла, значения ниже —
 * это уже ГОТОВЫЕ ставки с НДС, а не базовая ставка + отдельное умножение
 * на 1.16. Раньше здесь хранилась ставка БЕЗ НДС и calcKaspiCommissionAmount
 * домножал её на коэффициент — из-за округления официальная ставка с НДС
 * не всегда точно совпадает с (безНДС × 1.16), поэтому теперь берём цифру
 * с НДС из таблицы напрямую, без домножения (см. calcKaspiCommissionAmount).
 *
 * Логика: подавляющее большинство категорий 2–5 уровня внутри одной
 * категории 1-го уровня имеют ОДИНАКОВУЮ комиссию — поэтому вместо базы
 * из тысяч строк храним:
 *   1) базовую ставку по категории 1-го уровня;
 *   2) точечные исключения там, где ставка внутри категории отличается.
 */

// Три основные ставки (с НДС), встречающиеся в таблице Kaspi:
export const KASPI_RATE_DEFAULT = 12.5; // подавляющее большинство категорий, включая "Красота и здоровье"
export const KASPI_RATE_FOOD_PHARMACY = 7.3; // продукты питания и часть аптеки (лекарства)
export const KASPI_RATE_PREMIUM_ACCESSORIES = 15.5; // часть аксессуаров/украшений

// Базовая ставка по категории 1-го уровня (используется как fallback, если
// товар не размечен более точной подкатегорией).
export const KASPI_TOP_CATEGORY_RATE: Record<string, number> = {
  'Автотовары': KASPI_RATE_DEFAULT,
  'Аксессуары': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Аптека': KASPI_RATE_DEFAULT, // база 12.5%, конкретные лекарства — см. LEAF_OVERRIDES (7.3%)
  'Бытовая техника': KASPI_RATE_DEFAULT,
  'Детские товары': KASPI_RATE_DEFAULT,
  'Досуг, книги': KASPI_RATE_DEFAULT,
  'Канцелярские товары': KASPI_RATE_DEFAULT,
  'Компьютеры': KASPI_RATE_DEFAULT,
  'Красота и здоровье': KASPI_RATE_DEFAULT,
  'Мебель': KASPI_RATE_DEFAULT,
  'Обувь': KASPI_RATE_DEFAULT,
  'Одежда': KASPI_RATE_DEFAULT,
  'Подарки, товары для праздников': KASPI_RATE_DEFAULT,
  'Продукты питания': KASPI_RATE_FOOD_PHARMACY,
  'Спорт, туризм': KASPI_RATE_DEFAULT,
  'Строительство, ремонт': KASPI_RATE_DEFAULT,
  'ТВ, Аудио, Видео': KASPI_RATE_DEFAULT,
  'Телефоны и гаджеты': KASPI_RATE_DEFAULT,
  'Товары для дома и дачи': KASPI_RATE_DEFAULT,
  'Товары для животных': KASPI_RATE_DEFAULT,
  'Украшения': KASPI_RATE_PREMIUM_ACCESSORIES,
};

// Точечные исключения — leaf-категория (5-й уровень, как указано в таблице
// Kaspi), для которой ставка отличается от базовой по категории 1-го уровня.
// Ключ — точное название leaf-категории из карточки товара в Kaspi.
const LEAF_OVERRIDES: Record<string, number> = {
  // --- Аптека: рецептурные/безрецептурные лекарства идут по льготной ставке ---
  'Противомикробные препараты': KASPI_RATE_FOOD_PHARMACY,
  'Простуда, насморк, боль в горле': KASPI_RATE_FOOD_PHARMACY,
  'При аллергии': KASPI_RATE_FOOD_PHARMACY,
  'Нервная система': KASPI_RATE_FOOD_PHARMACY,
  'Сердечно-сосудистые': KASPI_RATE_FOOD_PHARMACY,
  'Здоровье глаз': KASPI_RATE_FOOD_PHARMACY,
  'Витаминные препараты': KASPI_RATE_FOOD_PHARMACY,
  'Дезинфицирующие средства': KASPI_RATE_FOOD_PHARMACY,
  'Боль и воспаления': KASPI_RATE_FOOD_PHARMACY,
  'Желудок, кишечник, печень': KASPI_RATE_FOOD_PHARMACY,
  'Лечебные кремы, мази и масла': KASPI_RATE_FOOD_PHARMACY,
  'Эндокринная система, диабет': KASPI_RATE_FOOD_PHARMACY,
  'Кожа, волосы, ногти': KASPI_RATE_FOOD_PHARMACY,
  'Мышцы, кости и суставы': KASPI_RATE_FOOD_PHARMACY,
  'Гинекология и урология': KASPI_RATE_FOOD_PHARMACY,

  // --- Аксессуары: базовая ставка 15.5%, но эта группа — по умолчанию ---
  'Солнцезащитные очки': KASPI_RATE_DEFAULT,
  'Чемоданы': KASPI_RATE_DEFAULT,
  'Карманные часы': KASPI_RATE_DEFAULT,
  'Дорожные сумки': KASPI_RATE_DEFAULT,
  'Часы наручные': KASPI_RATE_DEFAULT,
  'Футляры для очков': KASPI_RATE_DEFAULT,
  'Уход за очками': KASPI_RATE_DEFAULT,
  'Чехлы для чемоданов': KASPI_RATE_DEFAULT,
  'Держатели для очков': KASPI_RATE_DEFAULT,
  'Дорожные аксессуары': KASPI_RATE_DEFAULT,
  'Ремешки и браслеты для часов': KASPI_RATE_DEFAULT,

  // --- Телефоны и гаджеты: базовая ставка по умолчанию, но аксессуары для
  // телефонов (кроме зарядок/повербанков) — по премиум-ставке ---
  'Чехлы для смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Чехлы для зарядных устройств и кабелей': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Защитные пленки и стекла для смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Вакуумные сепараторы': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Инструменты для обслуживания смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Увеличительные экраны для смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Смарт-линзы для смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Системы охлаждения для смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Держатели для телефонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Дисплеи для смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Кабели и переходники для смартфонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Наклейки для телефонов': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Дополнительное оборудование для смартфона': KASPI_RATE_PREMIUM_ACCESSORIES,
  'Аккумуляторы для телефонов': KASPI_RATE_PREMIUM_ACCESSORIES,

  // --- ТВ, Аудио, Видео: почти всё по умолчанию, кроме ---
  'Чехлы для наушников': KASPI_RATE_PREMIUM_ACCESSORIES,
};

// Категории (leaf), где применяется льготная ставка продуктов питания внутри
// "Товары для животных" — определяется по ключевым словам, т.к. таких
// leaf-категорий десятки (Корма/Лакомства для каждого вида животного).
const PET_FOOD_KEYWORDS = /корм|лакомств|наполнител.*туалет/i;

export interface KaspiCommissionInput {
  topCategory: string; // Категория 1-го уровня, как в карточке Kaspi
  leafCategory?: string; // Самая точная категория товара (2–5 уровня)
}

/**
 * Возвращает комиссию Kaspi (С УЧЁТОМ НДС, в %) для товара по его категории.
 * Если leaf-категория неизвестна или не найдена в исключениях — используется
 * базовая ставка по категории 1-го уровня. Если и она неизвестна — 12.5%
 * (самая распространённая ставка на площадке) — так комиссия НИКОГДА не
 * считается нулевой, даже без единой известной категории.
 */
export function getKaspiCommissionRate(input: KaspiCommissionInput): number {
  const { topCategory, leafCategory } = input;

  if (topCategory === 'Товары для животных' && leafCategory && PET_FOOD_KEYWORDS.test(leafCategory)) {
    return KASPI_RATE_FOOD_PHARMACY;
  }

  if (leafCategory && leafCategory in LEAF_OVERRIDES) {
    return LEAF_OVERRIDES[leafCategory];
  }

  if (topCategory in KASPI_TOP_CATEGORY_RATE) {
    return KASPI_TOP_CATEGORY_RATE[topCategory];
  }

  return KASPI_RATE_DEFAULT; // безопасный дефолт — комиссия никогда не 0
}

/**
 * Сумма комиссии в тенге для конкретной продажи. Ставка из
 * getKaspiCommissionRate() — это уже готовая ставка С НДС, поэтому здесь
 * больше НЕТ отдельного домножения на коэффициент НДС (раньше было —
 * убрано, чтобы не применять НДС дважды).
 */
export function calcKaspiCommissionAmount(revenue: number, input: KaspiCommissionInput): number {
  const rate = getKaspiCommissionRate(input);
  return Math.round((revenue * rate) / 100 * 100) / 100;
}
