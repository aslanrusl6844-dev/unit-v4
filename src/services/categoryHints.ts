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

type Gendered = { female: string; male: string };

interface HintRule {
  match: RegExp;
  exclude?: RegExp;
  type: string;
  category: string | Gendered;
  weak?: boolean;
}

const FEMALE_MALE = { female: 'Женская одежда', male: 'Мужская одежда' };

export const HINT_RULES: HintRule[] = [
  // Одежда: категория зависит от пола в названии.
  { match: /джинс/, exclude: /джинсов/, type: 'Джинсы', category: FEMALE_MALE }, // «джинсовая куртка» — не джинсы
  { match: /пижам/, type: 'Пижамы', category: FEMALE_MALE },
  { match: /шорт/, type: 'Шорты', category: FEMALE_MALE },
  { match: /рубашк/, type: 'Рубашки', category: FEMALE_MALE },
  { match: /юбк/, type: 'Юбки', category: 'Женская одежда' },
  { match: /плать/, type: 'Платья', category: 'Женская одежда' },
  // Косметика
  { match: /шампун/, type: 'Шампунь', category: 'Красота и здоровье' }, // шампунь / шампуни
  { match: /гель для душа/, type: 'Гель для душа', category: 'Красота и здоровье' },
  { match: /крем для лица/, type: 'Крем', category: 'Красота и здоровье' },
  // «гель» сам по себе — слабое правило: только делает «шампунь-гель» спорным.
  { match: /(?:^|[^а-я])гел[ьяиюе]/, type: 'Гель для душа', category: 'Красота и здоровье', weak: true },
  // Краска для волос: нужны оба слова («краск…» и «волос…») в любом порядке.
  { match: /краск.*волос|волос.*краск/, type: 'Краска для волос', category: 'Красота и здоровье' },
  // Кухня и электроника
  { match: /кофеварк/, type: 'Кофеварка', category: 'Бытовая техника' },
  { match: /наушник/, type: 'Наушники', category: 'Электроника' },
];

export type HintStatus = 'none' | 'single' | 'multiple';

export interface HintResult {
  status: HintStatus;
  /** single — ровно один вариант (его можно ставить автоматически);
   *  multiple — 2–3 варианта, автоматически НЕ ставится; none — пусто. */
  variants: CategoryVariant[];
}

const MAX_VARIANTS = 3;

function normalizeName(name: string): string {
  return String(name ?? '').toLowerCase().replace(/ё/g, 'е');
}

function categoriesFor(rule: HintRule, name: string): string[] {
  if (typeof rule.category === 'string') return [rule.category];
  const female = /женск/.test(name);
  const male = /мужск/.test(name);
  if (female && !male) return [rule.category.female];
  if (male && !female) return [rule.category.male];
  // Пола нет (или указаны оба) — честно даём оба варианта, выбирать пользователю.
  return [rule.category.female, rule.category.male];
}

/** Подсказка по названию. Не обращается ни к базе, ни к сети. */
export function hintCategoryByName(rawName: string | null | undefined): HintResult {
  const name = normalizeName(rawName ?? '');
  if (!name.trim()) return { status: 'none', variants: [] };

  const strong: Array<{ v: CategoryVariant; pos: number }> = [];
  const weak: Array<{ v: CategoryVariant; pos: number }> = [];

  for (const rule of HINT_RULES) {
    const m = rule.match.exec(name);
    if (!m) continue;
    if (rule.exclude && rule.exclude.test(name)) continue;
    for (const category of categoriesFor(rule, name)) {
      (rule.weak ? weak : strong).push({ v: { category, type: rule.type }, pos: m.index });
    }
  }

  // Порядок вариантов — как слова идут в названии («платье-рубашка»: платья первыми).
  const key = (v: CategoryVariant) => `${v.category}|${v.type}`;
  const unique = (list: Array<{ v: CategoryVariant; pos: number }>) => {
    const seen = new Set<string>();
    return list
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => a.pos - b.pos || a.i - b.i)
      .filter((x) => (seen.has(key(x.v)) ? false : (seen.add(key(x.v)), true)))
      .map((x) => x.v);
  };

  const strongVariants = unique(strong);
  if (!strongVariants.length) return { status: 'none', variants: [] }; // одно слабое правило подсказку не даёт

  // Слабое правило с другим типом делает название спорным.
  const strongKeys = new Set(strongVariants.map(key));
  const weakExtra = unique(weak).filter((v) => !strongKeys.has(key(v)));

  const all = [...strongVariants, ...weakExtra];
  if (all.length === 1) return { status: 'single', variants: all };
  return { status: 'multiple', variants: all.slice(0, MAX_VARIANTS) };
}

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
export const STARTER_CATALOG: CatalogCategory[] = [
  {
    category: 'Красота и здоровье',
    types: ['Шампунь', 'Гель для душа', 'Крем', 'Краска для волос', 'Тоник', 'Пилинг', 'Сыворотка', 'Маска', 'Тушь', 'Помада', 'Палетка', 'Парфюм'],
  },
];

export function starterCatalogPairs(): CategoryVariant[] {
  return STARTER_CATALOG.flatMap((c) => c.types.map((type) => ({ category: c.category, type })));
}

/** Все пары category/type, которые знает справочник правил. */
export function hintRuleCatalogPairs(): CategoryVariant[] {
  const pairs: CategoryVariant[] = [];
  for (const rule of HINT_RULES) {
    const cats = typeof rule.category === 'string' ? [rule.category] : [rule.category.female, rule.category.male];
    for (const category of cats) pairs.push({ category, type: rule.type });
  }
  return pairs;
}

/** Собирает каталог «категория → её типы» из любых пар; без дублей, по алфавиту. */
export function buildCatalog(pairs: Array<{ category: string | null | undefined; type: string | null | undefined }>): CatalogCategory[] {
  // Типы внутри категории склеиваются без учёта регистра и лишних пробелов:
  // «краска для волос» и «Краска для волос» — один тип. Остаётся написание,
  // встреченное первым (порядок pairs: стартовый список и правила идут раньше своих).
  const map = new Map<string, Map<string, string>>();
  for (const p of pairs) {
    const category = (p.category ?? '').trim();
    const type = (p.type ?? '').replace(/\s+/g, ' ').trim();
    if (!category || !type) continue;
    if (!map.has(category)) map.set(category, new Map());
    const key = type.toLowerCase();
    if (!map.get(category)!.has(key)) map.get(category)!.set(key, type);
  }
  return Array.from(map.entries())
    .map(([category, types]) => ({ category, types: Array.from(types.values()).sort((a, b) => a.localeCompare(b, 'ru')) }))
    .sort((a, b) => a.category.localeCompare(b.category, 'ru'));
}
