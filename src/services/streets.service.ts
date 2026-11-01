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

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Центр города и полуразмер прямоугольника (градусы широты/долготы). Прямоугольник — лёгкий запрос
 *  для серверов карты (поиск по границам города они не успевали). Может захватить пригородные посёлки. */
export const CITY_BBOX: Record<string, [lat: number, lon: number, dLat: number, dLon: number]> = {
  'Алматы': [43.238, 76.889, 0.17, 0.25],
  'Астана': [51.128, 71.430, 0.15, 0.25],
  'Шымкент': [42.317, 69.596, 0.12, 0.18],
  'Караганда': [49.806, 73.085, 0.10, 0.16],
  'Актобе': [50.283, 57.167, 0.10, 0.15],
  'Тараз': [42.900, 71.367, 0.08, 0.12],
  'Павлодар': [52.287, 76.967, 0.08, 0.12],
  'Усть-Каменогорск': [49.948, 82.628, 0.08, 0.13],
  'Семей': [50.411, 80.227, 0.08, 0.12],
  'Атырау': [47.107, 51.903, 0.08, 0.12],
  'Костанай': [53.214, 63.632, 0.07, 0.11],
  'Кызылорда': [44.853, 65.509, 0.07, 0.11],
  'Уральск': [51.233, 51.367, 0.07, 0.11],
  'Петропавловск': [54.872, 69.143, 0.06, 0.10],
  'Актау': [43.651, 51.158, 0.07, 0.10],
  'Туркестан': [43.297, 68.252, 0.06, 0.09],
  'Кокшетау': [53.283, 69.383, 0.06, 0.09],
  'Талдыкорган': [45.017, 78.383, 0.06, 0.09],
  'Экибастуз': [51.723, 75.323, 0.05, 0.08],
  'Жезказган': [47.783, 67.767, 0.05, 0.08],
};

export function buildOverpassQuery(city: string): string {
  const box = CITY_BBOX[city];
  if (!box) throw new Error(`Нет координат для города ${city}`);
  const [lat, lon, dLat, dLon] = box;
  const f = (n: number) => n.toFixed(4);
  return `[out:json][timeout:50][bbox:${f(lat - dLat)},${f(lon - dLon)},${f(lat + dLat)},${f(lon + dLon)}];
(
  way[highway~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"][name];
  node[place~"^(suburb|neighbourhood|quarter)$"][name];
);
out tags;`;
}

/** Скачивает названия улиц города из OpenStreetMap: опрашивает все зеркала сразу, берёт первый удачный ответ. */
export async function fetchCityStreets(city: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const body = `data=${encodeURIComponent(buildOverpassQuery(city))}`;
  const stop = new AbortController();
  const errors: string[] = [];
  const attempts = OVERPASS_MIRRORS.map(async (url) => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'my-market-unit/1.0' },
        body,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(52_000)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const names = parseOverpassNames((await res.json()) as OverpassResponse);
      if (!names.length) throw new Error('пустой ответ');
      return names;
    } catch (e: any) {
      errors.push(`${new URL(url).host}: ${String(e?.message ?? e).slice(0, 60)}`);
      throw e;
    }
  });
  try {
    const names = await Promise.any(attempts);
    stop.abort(); // остальные зеркала больше не ждём
    return names;
  } catch {
    throw new Error(`Серверы карты не ответили: ${errors.join('; ')}`);
  }
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
