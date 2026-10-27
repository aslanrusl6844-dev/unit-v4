/** Города, для которых в админке загружаются картинки («Картинки городов»). Порядок — как показывается в админке. */
export const CITY_IMAGE_CITIES = [
  'Алматы', 'Астана', 'Шымкент', 'Караганда', 'Актобе', 'Тараз', 'Павлодар', 'Усть-Каменогорск', 'Семей', 'Атырау',
  'Костанай', 'Кызылорда', 'Уральск', 'Петропавловск', 'Актау', 'Туркестан', 'Кокшетау', 'Талдыкорган', 'Экибастуз', 'Жезказган',
] as const;

/** Старые/альтернативные названия → город из списка. */
const ALIASES = new Map<string, string>(Object.entries({
  'алма-ата': 'Алматы', 'алма ата': 'Алматы',
  'нур-султан': 'Астана', 'нурсултан': 'Астана', 'нур султан': 'Астана', 'целиноград': 'Астана', 'акмола': 'Астана',
  'чимкент': 'Шымкент',
}));

/** Сопоставление без учёта регистра, ё/е, дефисов/пробелов и лишних пробелов. */
export function normalizeCityKey(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[-–—\s]+/g, ' ')
    .trim();
}

const BY_KEY = new Map<string, string>(CITY_IMAGE_CITIES.map((c) => [normalizeCityKey(c), c]));

/** Каноническое название города из списка или null, если города нет в списке. */
export function resolveCity(raw: unknown): string | null {
  const key = normalizeCityKey(raw);
  if (!key) return null;
  return BY_KEY.get(key) ?? ALIASES.get(key) ?? null;
}

/** Максимум картинок (слайдов) на один город. */
export const MAX_CITY_IMAGES = 10;
