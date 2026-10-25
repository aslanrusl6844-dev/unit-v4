import { prisma } from '../db/prisma';

/**
 * Подсказки поиска My Market. Источники: категории, типы, популярные
 * (успешные) запросы покупателей и названия товаров — только из товаров,
 * которые видны в приложении. Текущий поиск товаров не затрагивается.
 */
export const SUGGEST_MIN_LEN = 2;
export const SUGGEST_MAX_LEN = 50;
export const SUGGEST_LIMIT = 10;
const POPULAR_DAYS = 90;
const POPULAR_MIN_COUNT = 2; // запрос должен повториться — разовые строки (в т.ч. личные) не показываем
const MAX_LABEL = 80;

export type SuggestionType = 'category' | 'type' | 'popular' | 'product';
export interface Suggestion { text: string; type: SuggestionType }

export function normalizeSuggestQuery(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, SUGGEST_MAX_LEN);
}

/** Совпадение с начала слова ранжируем выше, чем «где-то внутри». */
function rank(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.split(/[\s\-/,()]+/).some((w) => w.startsWith(q))) return 1;
  return 2;
}

function pushUnique(out: Suggestion[], seen: Set<string>, text: string | null | undefined, type: SuggestionType, limit: number) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  const label = t.length > MAX_LABEL ? t.slice(0, MAX_LABEL).trim() : t;
  const key = label.toLowerCase();
  if (seen.has(key) || out.length >= limit) return;
  seen.add(key);
  out.push({ text: label, type });
}

export async function getSearchSuggestions(rawQuery: unknown, visibleWhere: Record<string, unknown>, now = new Date()): Promise<Suggestion[]> {
  const q = normalizeSuggestQuery(rawQuery);
  if (q.length < SUGGEST_MIN_LEN) return [];
  const contains = { contains: q, mode: 'insensitive' as const };

  const [products, popular] = await Promise.all([
    prisma.product.findMany({
      where: { ...visibleWhere, OR: [{ name: contains }, { category: contains }, { type: contains }] },
      select: { name: true, category: true, type: true },
      take: 300,
    }),
    prisma.shopEvent.groupBy({
      by: ['query'],
      where: {
        type: 'search',
        resultsCount: { gt: 0 },
        createdAt: { gte: new Date(now.getTime() - POPULAR_DAYS * 86400_000) },
        query: { startsWith: q, mode: 'insensitive' },
      },
      _count: { query: true },
      having: { query: { _count: { gte: POPULAR_MIN_COUNT } } },
      orderBy: { _count: { query: 'desc' } },
      take: 5,
    }),
  ]);

  const has = (s: unknown) => typeof s === 'string' && s.toLowerCase().includes(q);
  const categories = Array.from(new Set(products.map((p: any) => p.category).filter(has))) as string[];
  const types = Array.from(new Set(products.map((p: any) => p.type).filter(has))) as string[];
  const names = Array.from(new Set(products.map((p: any) => p.name).filter(has))) as string[];
  const byRank = (a: string, b: string) => rank(a, q) - rank(b, q) || a.length - b.length || a.localeCompare(b, 'ru');

  const out: Suggestion[] = [];
  const seen = new Set<string>();
  categories.sort(byRank).slice(0, 2).forEach((c) => pushUnique(out, seen, c, 'category', SUGGEST_LIMIT));
  types.sort(byRank).slice(0, 2).forEach((t) => pushUnique(out, seen, t, 'type', SUGGEST_LIMIT));
  (popular as Array<{ query: string | null }>).forEach((r) => pushUnique(out, seen, r.query, 'popular', SUGGEST_LIMIT));
  names.sort(byRank).forEach((n) => pushUnique(out, seen, n, 'product', SUGGEST_LIMIT));
  return out;
}
