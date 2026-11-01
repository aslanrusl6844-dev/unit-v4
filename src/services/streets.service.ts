/**
 * Подсказки улиц без платных карт: названия улиц и микрорайонов города берём один раз из
 * OpenStreetMap (Overpass API, открытые данные ODbL), храним в своей таблице ShopStreet и ищем по ней.
 * Номера домов не подсказываем — их вводят вручную.
 */
import { prisma } from '../db/prisma';

const TYPE_WORDS = new Set([
  'улица', 'ул', 'проспект', 'пр', 'пр-т', 'пркт', 'переулок', 'пер', 'бульвар', 'бул', 'площадь', 'пл',
  'микрорайон', 'мкр', 'мкрн', 'мр', 'шоссе', 'ш', 'тупик', 'проезд', 'пр-д', 'набережная', 'наб', 'квартал',
  'жилой', 'массив', 'жм', 'район', 'аллея', 'тракт', 'көшесі', 'даңғылы', 'көш',
]);

/** Ключ для поиска: нижний регистр, ё→е, без слов «улица/проспект…», без знаков. */
export function streetKey(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !TYPE_WORDS.has(w))
    .join(' ')
    .trim();
}

export interface OverpassResponse { elements?: Array<{ tags?: Record<string, string> }> }

/** Названия из ответа Overpass: без повторов, мусора и чисто цифровых имён. */
export function parseOverpassNames(json: OverpassResponse): string[] {
  const seen = new Set<string>();
  for (const el of json?.elements ?? []) {
    const raw = el.tags?.['name:ru'] ?? el.tags?.name;
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60 || /^[\d\s.,-]+$/.test(name)) continue;
    if (!streetKey(name)) continue;
    seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'ru'));
}

const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export function buildOverpassQuery(city: string): string {
  const c = city.replace(/[^\p{L}\p{N} -]/gu, '');
  return `[out:json][timeout:25];
area[boundary=administrative][~"^name(:ru)?$"~"^${c}$"]->.a;
(
  way[highway][name][highway!~"^(footway|path|steps|cycleway|track|bridleway|corridor|elevator|proposed|construction|service)$"](area.a);
  nwr[place~"^(suburb|neighbourhood|quarter)$"][name](area.a);
);
out tags;`;
}

/** Скачивает названия улиц города из OpenStreetMap (пробует зеркала Overpass по очереди). */
export async function fetchCityStreets(city: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const errors: string[] = [];
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'my-market-unit/1.0' },
        body: `data=${encodeURIComponent(buildOverpassQuery(city))}`,
        signal: AbortSignal.timeout(26_000), // два зеркала × 26 с укладываются в лимит 55 с
      });
      if (!res.ok) { errors.push(`${url} ${res.status}`); continue; }
      return parseOverpassNames((await res.json()) as OverpassResponse);
    } catch (e: any) {
      errors.push(`${url} ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  throw new Error(`Overpass недоступен: ${errors.join('; ')}`);
}

/** Заменяет улицы города новым списком. Пустой список не записываем — чтобы сбой не стёр старые данные. */
export async function saveCityStreets(city: string, names: string[]): Promise<number> {
  if (!names.length) throw new Error('В OpenStreetMap для этого города улиц не найдено');
  const data = names.map((name) => ({ city, name, key: streetKey(name) }));
  await prisma.$transaction([
    prisma.shopStreet.deleteMany({ where: { city } }),
    prisma.shopStreet.createMany({ data, skipDuplicates: true }),
  ]);
  return data.length;
}

export interface StreetRow { name: string; key: string }

/** Порядок подсказок: сначала начинающиеся с введённого, потом слова внутри названия, потом остальные. */
export function rankStreets(rows: StreetRow[], query: string, limit = 8): string[] {
  const q = streetKey(query);
  if (q.length < 2) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const r of rows) {
    let score: number;
    if (r.key.startsWith(q)) score = 0;
    else if (r.key.split(' ').some((w) => w.startsWith(q))) score = 1;
    else if (r.key.includes(q)) score = 2;
    else continue;
    scored.push({ name: r.name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name, 'ru'));
  return scored.slice(0, limit).map((s) => s.name);
}

export async function searchStreets(city: string, query: string, limit = 8): Promise<string[]> {
  const q = streetKey(query);
  if (q.length < 2) return [];
  const rows = await prisma.shopStreet.findMany({
    where: { city, key: { contains: q } },
    select: { name: true, key: true },
    take: 80,
  });
  return rankStreets(rows, query, limit);
}
