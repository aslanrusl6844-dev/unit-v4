import { Router } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { SHOP_CATEGORIES } from '../config/shopCategories';
import {
  ChatMessage, DEFAULT_MODEL, MarkerStripper, buildSystemPrompt, extractSkus, loadCatalog, rankProducts, streamClaude,
} from '../services/assistant.service';

export const assistantRouter = Router();

// Свой x-app-key (роутер смонтирован раньше shopRouter, его проверка сюда не доходит).
assistantRouter.use((req, res, next) => {
  if (!env.shopAppKey) return res.status(503).json({ error: 'SHOP_APP_KEY не настроен' });
  if (req.header('x-app-key') !== env.shopAppKey) return res.status(401).json({ error: 'Неверный x-app-key' });
  next();
});

// Простейший лимит на IP: 20 запросов в минуту (память функции; от случайных циклов, не от атак).
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

export function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 2000) }))
    .slice(-12);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

assistantRouter.post('/', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Ассистент пока не подключён (нет ANTHROPIC_API_KEY)' });
  if (limited(req.ip || 'x')) return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
  const messages = sanitizeMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Нужен хотя бы один вопрос' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    const catalog = await loadCatalog();
    const lastUsers = messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
    const found = rankProducts(catalog, lastUsers, 8);
    const system = buildSystemPrompt(found, [...SHOP_CATEGORIES]);
    const strip = new MarkerStripper();
    const full = await streamClaude({
      apiKey, model: process.env.ASSISTANT_MODEL || DEFAULT_MODEL, system, messages, signal: ac.signal,
      onDelta: (t) => { const clean = strip.push(t); if (clean) send('delta', { text: clean }); },
    });
    const tail = strip.flush();
    if (tail) send('delta', { text: tail });
    const bySku = new Map(catalog.map((p) => [p.sku, p]));
    const cards = extractSkus(full).map((s) => bySku.get(s)).filter(Boolean).slice(0, 4);
    send('products', { items: cards });
    send('done', {});
  } catch (e: any) {
    logger.error({ err: e }, 'assistant error');
    send('error', { message: 'Ассистент временно недоступен, попробуйте ещё раз' });
  } finally {
    res.end();
  }
});
