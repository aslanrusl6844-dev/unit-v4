import { prisma } from '../db/prisma';
import { SHOP_VISIBLE_WHERE, toShopProduct } from '../routes/shop.routes';
import { PERSONA, SHOP_KNOWLEDGE } from '../config/assistantKnowledge';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface CatalogItem {
  sku: string; name: string; category: string | null; subcategory: string | null;
  type: string | null; price: number | null; image: string | null;
}

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
// Грубый «стемминг»: режем окончание, чтобы «платья» находило «платье».
const stem = (w: string) => (w.length > 5 ? w.slice(0, -2) : w.length > 3 ? w.slice(0, -1) : w);
const tokens = (s: string) => norm(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 2).map(stem);

/** Ранжирование каталога по запросу (чистая функция — легко тестировать). */
export function rankProducts(items: CatalogItem[], query: string, limit = 8): CatalogItem[] {
  const q = tokens(query);
  if (!q.length) return [];
  const scored = items.map((it) => {
    const name = norm(it.name);
    const meta = norm([it.category, it.subcategory, it.type].filter(Boolean).join(' '));
    let score = 0;
    for (const t of q) {
      if (name.includes(t)) score += 3;
      else if (meta.includes(t)) score += 1;
    }
    return { it, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.it);
}

/** Достаём артикулы [[sku:123]] из текста ответа. */
export function extractSkus(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[\s*sku\s*:\s*([^\]\s]+)\s*\]\]/gi)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Потоковый фильтр: не пропускает [[sku:..]] в видимый текст, даже если маркер пришёл по кускам. */
export class MarkerStripper {
  private buf = '';
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      const open = this.buf.indexOf('[[');
      if (open === -1) {
        // хвост "[" может быть началом маркера — придержим
        if (this.buf.endsWith('[')) { out += this.buf.slice(0, -1); this.buf = '['; } else { out += this.buf; this.buf = ''; }
        return out;
      }
      out += this.buf.slice(0, open);
      const close = this.buf.indexOf(']]', open);
      if (close === -1) { this.buf = this.buf.slice(open); return out; }
      this.buf = this.buf.slice(close + 2);
    }
  }
  flush(): string { const r = /^\[\[?$/.test(this.buf) || this.buf.startsWith('[[') ? '' : this.buf; this.buf = ''; return r; }
}

let cache: { at: number; items: CatalogItem[] } | null = null;
const CACHE_MS = 5 * 60_000;

export async function loadCatalog(): Promise<CatalogItem[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const rows = await prisma.product.findMany({ where: SHOP_VISIBLE_WHERE, take: 3000 });
  const items = rows.map((r: any) => {
    const p = toShopProduct(r);
    return {
      sku: String(p.sku), name: p.name, category: p.category ?? null, subcategory: p.subcategory ?? null,
      type: p.type ?? null, price: p.price ?? null, image: Array.isArray(p.images) && p.images[0] ? String(p.images[0]) : null,
    } as CatalogItem;
  });
  cache = { at: Date.now(), items };
  return items;
}

export function buildSystemPrompt(found: CatalogItem[], categories: string[]): string {
  const list = found.length
    ? found.map((p) => `- артикул ${p.sku}: ${p.name} (${[p.category, p.subcategory].filter(Boolean).join(' / ')}), ${p.price} ₸`).join('\n')
    : '(по последнему запросу ничего не найдено — не придумывай товары, предложи уточнить запрос или посмотреть раздел)';
  return `${PERSONA}\n\n${SHOP_KNOWLEDGE}\n\nРАЗДЕЛЫ КАТАЛОГА: ${categories.join(', ')}\n\nНАЙДЕННЫЕ ТОВАРЫ:\n${list}`;
}

/** Стрим ответа Claude. onDelta вызывается с чистыми кусками текста. */
export async function streamClaude(opts: {
  apiKey: string; model: string; system: string; messages: ChatMessage[];
  onDelta: (t: string) => void; signal?: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: opts.model, max_tokens: 600, stream: true, system: opts.system, messages: opts.messages }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const reader = (res.body as any).getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { full += ev.delta.text; opts.onDelta(ev.delta.text); }
        else if (ev.type === 'error') throw new Error(ev.error?.message ?? 'stream error');
      } catch (e: any) { if (e?.message && !(e instanceof SyntaxError)) throw e; }
    }
  }
  return full;
}
