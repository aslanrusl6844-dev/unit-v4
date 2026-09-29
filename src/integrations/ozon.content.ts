/**
 * Очистка контента Ozon для карточки My Market. Чистые функции, без обращений
 * к сети и базе — чтобы правила легко проверять и переиспользовать и в синке
 * (запись в базу), и в API приложения (страховка при чтении).
 *
 * Правило: из Ozon берём только то, что имеет смысл для покупателя. Хештеги,
 * ТН ВЭД, код маркировки, код продавца, «Нет бренда», служебные true/false —
 * не показываем нигде.
 */

const HASHTAG_RE = /#[\p{L}\p{N}_-]+/gu;

/** Значения-пустышки: показывать покупателю нельзя. */
const GARBAGE_VALUES = new Set([
  'нет бренда', 'без бренда', 'нет', '-', '—', '–', 'true', 'false',
  'не указан', 'не указана', 'не указано', 'отсутствует', 'нет данных', 'n/a',
]);

export function isGarbageValue(v: string | null | undefined): boolean {
  if (v == null) return true;
  const t = String(v).trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return true;
  if (GARBAGE_VALUES.has(t)) return true;
  if (t.includes('#')) return true; // хештеги
  return false;
}

/** Предложения описания с этим содержанием выбрасываем целиком. */
const DESCRIPTION_JUNK: RegExp[] = [
  /оферт/iu,
  /доставк\p{L}*[^.!?\n]{0,25}(?:^|[^\p{L}])(?:рф|росси\p{L}*)/iu, // «доставка по РФ», «доставка по всей России»
  /тн\s*вэд/iu,
  /код\s+маркировк/iu,
  /код\s+продавц/iu,
  /нет\s+бренда/iu,
  /артикул/iu,
];

/**
 * Описание = только аннотация товара, без оферты, «доставки по РФ»,
 * хештегов, ТН ВЭД, кодов и артикула. Чистим по предложениям: хештег внутри
 * предложения просто вырезается, предложение с «мусорными» маркерами
 * выбрасывается целиком. Возвращает '' если после чистки ничего не осталось.
 */
export function cleanOzonDescription(raw: string | null | undefined): string {
  if (!raw) return '';
  const text = String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r/g, '');
  const paragraphs: string[] = [];
  for (const para of text.split(/\n+/)) {
    const kept = para
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.replace(HASHTAG_RE, '').replace(/[ \t]{2,}/g, ' ').trim())
      .filter((s) => /[\p{L}\p{N}]/u.test(s) && !DESCRIPTION_JUNK.some((re) => re.test(s)));
    if (kept.length) paragraphs.push(kept.join(' '));
  }
  return paragraphs.join('\n').trim();
}

/** Чистый текст состава: без хештегов и пустышек. '' если чистить нечего. */
export function cleanOzonComposition(raw: string | null | undefined): string {
  if (!raw) return '';
  let t = String(raw)
    .replace(/<[^>]+>/g, '')
    .replace(HASHTAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (isGarbageValue(t)) return '';
  if (t.length > 2000) {
    let cut = t.slice(0, 2000);
    // Режем по границе слова: недописанное слово убираем, только если обрезка
    // пришлась ВНУТРИ слова; висящие запятые/пробелы на конце — всегда.
    if (!/[,;\s]/.test(t[2000])) cut = cut.replace(/[,;\s][^,;\s]*$/, '');
    t = cut.replace(/[\s,;]+$/, '');
  }
  return t;
}

/** Название атрибута Ozon — это именно «Состав» / «Состав/ингредиенты». */
export function isCompositionAttributeName(name: string | null | undefined): boolean {
  return !!name && /^состав(?:\s*[/,]\s*ингредиенты)?$/iu.test(name.trim());
}

export function isMaterialAttributeName(name: string | null | undefined): boolean {
  return !!name && /^материал(?:ы)?(?:\s+изделия)?$/iu.test(name.trim());
}

const DUMP_MARKERS = /#хештеги|тн\s*вэд|нужен\s+код\s+маркировки|код\s+продавца|нет\s+бренда/iu;

/** Текст похож на свалку атрибутов Ozon (то, что раньше писал синк в состав). */
export function looksLikeAttributeDump(text: string | null | undefined): boolean {
  return !!text && DUMP_MARKERS.test(text);
}

/**
 * Свалка прежнего формата синка: строки «Название: значение» по всем атрибутам.
 * Применяется ТОЛЬКО к тексту, который записал сам синк (compositionSource =
 * "ozon"): чистый состав — это один связный текст, а не список «ключ: значение».
 */
export function looksLikeLegacySyncDump(text: string | null | undefined): boolean {
  if (!text) return false;
  if (looksLikeAttributeDump(text)) return true;
  return text.split('\n').filter((l) => /^[^:\n]{2,60}:\s*\S/.test(l)).length >= 2;
}

export interface ShopCharacteristic { name: string; value: string }

// Что вообще можно показать покупателю в «Характеристиках». Белый список:
// источник шумный (бренд, пол, ТН ВЭД, коды…), надёжнее разрешить три
// понятные строки, чем вычёркивать мусор по одному.
const CHARACTERISTIC_NAMES = ['Тип', 'Материал', 'Артикул'] as const;

/** Оставляет только Тип / Материал / Артикул с нормальными значениями, в этом порядке. */
export function sanitizeCharacteristics(list: Array<{ name?: unknown; value?: unknown }> | null | undefined): ShopCharacteristic[] {
  const byName = new Map<string, string>();
  for (const item of Array.isArray(list) ? list : []) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const value = typeof item?.value === 'string' ? item.value.replace(/\s+/g, ' ').trim() : '';
    if (!(CHARACTERISTIC_NAMES as readonly string[]).includes(name) || byName.has(name)) continue;
    if (!value || value.length > 120 || isGarbageValue(value) || DUMP_MARKERS.test(value)) continue;
    byName.set(name, value);
  }
  return CHARACTERISTIC_NAMES.filter((n) => byName.has(n)).map((n) => ({ name: n, value: byName.get(n) as string }));
}

/**
 * Короткий список характеристик товара Ozon: Тип, Материал, Артикул.
 * «Артикул» — ТОЛЬКО shopArticle (свой, 7 цифр, генерируется отдельно) — сюда
 * НИКОГДА не передаётся offerId/nmId/kaspiSku площадки. Если shopArticle ещё
 * не сгенерирован (у товара пока нет ни цены, ни «В продаже») — строки
 * «Артикул» в характеристиках просто не будет, это не ошибка.
 */
export function buildCharacteristics(input: { typeName?: string; material?: string; shopArticle?: string | null }): ShopCharacteristic[] {
  return sanitizeCharacteristics([
    { name: 'Тип', value: input.typeName },
    { name: 'Материал', value: input.material },
    { name: 'Артикул', value: input.shopArticle ?? undefined },
  ]);
}
