import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { waitUntil } from '@vercel/functions';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { setWebhook, webhookSecret } from '../lib/telegramBot';
import { handleSceneJob, handleUpdate, setSelfBaseUrl } from '../services/productDraft.service';

export const telegramAgentRouter = Router();

function secretOk(given: string | undefined): boolean {
  if (!env.telegramBotToken || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(webhookSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Публичный путь (см. adminAuth), защита — секретный заголовок Telegram. */
telegramAgentRouter.post('/webhook', (req, res) => {
  if (!secretOk(req.header('x-telegram-bot-api-secret-token'))) return res.status(401).json({ ok: false });
  const host = req.header('x-forwarded-host') || req.header('host');
  if (host) setSelfBaseUrl(`https://${host}`);
  res.json({ ok: true }); // Telegram ждёт быстрый ответ; работа идёт дальше в фоне
  waitUntil(handleUpdate(req.body).catch((err) => logger.error({ err: String(err?.message ?? err) }, '[TelegramAgent] webhook')));
});

/** Админский (Basic) — один раз регистрирует вебхук бота на этот сервер. */
telegramAgentRouter.get('/setup', async (req, res) => {
  if (!env.telegramBotToken) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN не настроен' });
  const host = req.header('x-forwarded-host') || req.header('host');
  try {
    await setWebhook(`https://${host}/api/telegram-agent/webhook`);
    res.json({ ok: true, webhook: `https://${host}/api/telegram-agent/webhook` });
  } catch (err: any) {
    res.status(502).json({ error: 'Не удалось зарегистрировать вебхук', details: String(err?.message ?? err) });
  }
});

/** Служебный: рисует одну сцену (зовёт сам сервер, защита — тот же секрет). Отвечает сразу, работа в фоне. */
telegramAgentRouter.post('/scene', (req, res) => {
  if (!secretOk(req.header('x-telegram-bot-api-secret-token'))) return res.status(401).json({ ok: false });
  const { draftId, index } = req.body ?? {};
  if (typeof draftId !== 'string' || !Number.isInteger(index)) return res.status(400).json({ ok: false });
  res.json({ ok: true });
  waitUntil(handleSceneJob(draftId, index).catch((err) => logger.error({ err: String(err?.message ?? err) }, '[TelegramAgent] scene')));
});
