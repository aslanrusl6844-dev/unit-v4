import express, { Router } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { SHOP_CATEGORIES } from '../config/shopCategories';
import { MAX_AUDIO_BYTES, audioMime, transcribeAudio } from '../services/speechToText.service';
import {
  ChatMessage, DEFAULT_MODEL, buildSystemPrompt, diverseSample, extractSkus, loadCatalog, matchShowcases, rankProducts, runAssistant,
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

export function stripUiMarkers(text: string): string {
  return text.replace(/\{\{\s*все:[^}]*\}\}/g, '').replace(/\[\[[^\]]*\]\]/g, '').trim();
}

export function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    // Служебные маркеры приложения (подборка {{все:…}}, кнопки [[…]]) модели не нужны.
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: stripUiMarkers(String(m.content)).slice(0, 2000) }))
    .filter((m) => m.content.trim())
    .slice(-20);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/**
 * Голосовое сообщение (как в WhatsApp): тело запроса — сам файл (audio/mp4, до ~4 МБ), в ответ {text}.
 * Дальше приложение отправляет этот текст Баурсаку обычным запросом.
 */
assistantRouter.post('/transcribe', express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }), async (req, res) => {
  if (limited(req.ip || 'x')) return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (audio.length < 800) return res.status(400).json({ error: 'Пустая запись' });
  try {
    const t0 = Date.now();
    const lang = String(req.header('x-app-lang') ?? '').slice(0, 5).toLowerCase() || null;
    const text = await transcribeAudio({ audio, mime: audioMime(req.header('content-type')), lang });
    logger.info({ ms: Date.now() - t0, bytes: audio.length, chars: text.length }, 'assistant transcribe ok');
    res.json({ text });
  } catch (e: any) {
    logger.error({ err: e }, 'assistant transcribe error');
    res.status(502).json({ error: 'Не удалось распознать голос, попробуйте ещё раз' });
  }
});

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
    const { items: catalog, showcases } = await loadCatalog();
    const lastUsers = messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
    // Названа витрина/бренд — сначала её товары, потом остальные совпадения.
    const named = matchShowcases(showcases, lastUsers).map((x) => x.title);
    const inNamed = named.length ? catalog.filter((p) => p.showcases?.some((t) => named.includes(t))) : [];
    let found = rankProducts(inNamed.length ? inNamed : catalog, lastUsers, 14);
    if (inNamed.length && found.length < 14) found = [...found, ...inNamed.filter((p) => !found.includes(p))].slice(0, 14);
    if (!found.length) found = diverseSample(catalog, 12);
    const system = buildSystemPrompt(found, [...SHOP_CATEGORIES], showcases);
    const full = await runAssistant({
      apiKey, model: process.env.ASSISTANT_MODEL || DEFAULT_MODEL, system, messages, catalog: { items: catalog, showcases }, signal: ac.signal,
      onDelta: (t) => send('delta', { text: t }),
    });
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
