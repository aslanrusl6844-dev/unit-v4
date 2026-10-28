import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { normalizePhone } from './shop.routes';
import { sendBroadcast, isExpoToken, checkPushImage } from '../services/pushBroadcast.service';

/**
 * Админка → «Рассылка»: пуш всем покупателям с токеном (ShopCustomerPushToken)
 * или тестовый пуш на один номер. Вход — Basic admin (глобальный
 * adminAuthMiddleware на /api/*). Картинка — URL из существующей загрузки в Blob.
 */
export const pushAdminRouter = Router();

const httpsUrl = z.string().trim().max(2000).refine((u) => /^https:\/\/\S+$/i.test(u), 'Картинка должна быть ссылкой https://');

const sendSchema = z.object({
  title: z.string().trim().min(1, 'Укажи заголовок').max(100),
  body: z.string().trim().min(1, 'Укажи текст').max(500),
  imageUrl: httpsUrl.optional().nullable().or(z.literal('')),
  // 'test' — один номер (testPhone обязателен); 'all' — всем, только явно.
  audience: z.enum(['test', 'all']),
  testPhone: z.string().optional().nullable(),
});

/** Сколько получателей у рассылки «всем». */
pushAdminRouter.get('/audience', async (_req, res) => {
  try {
    const rows = await prisma.shopCustomerPushToken.findMany({ select: { token: true } });
    const expo = rows.filter((r: { token: string }) => isExpoToken(r.token)).length;
    res.json({ total: rows.length, expo, fcm: rows.length - expo, firebaseConfigured: !!(process.env.FIREBASE_KEY ?? '').trim() });
  } catch (err: any) {
    logger.error({ err }, '[PushAdmin] GET /audience упал');
    res.status(500).json({ error: 'Не удалось получить аудиторию', details: String(err?.message ?? err) });
  }
});

pushAdminRouter.post('/send', async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Неверные данные', details: parsed.error.flatten() });
  const { title, body, audience } = parsed.data;
  const imageUrl = parsed.data.imageUrl ? parsed.data.imageUrl : null; // '' / null → без картинки

  try {
    let tokens: string[] = [];
    if (audience === 'test') {
      const phone = normalizePhone(String(parsed.data.testPhone ?? ''));
      if (!phone) return res.status(400).json({ error: 'Для теста укажи корректный номер телефона' });
      const rec = await prisma.shopCustomerPushToken.findUnique({ where: { phone } });
      if (!rec?.token) return res.status(404).json({ error: 'У этого номера нет зарегистрированного токена — пуш некуда отправить' });
      tokens = [rec.token];
    } else {
      const rows = await prisma.shopCustomerPushToken.findMany({ select: { token: true } });
      tokens = rows.map((r: { token: string }) => r.token);
    }
    if (!tokens.length) return res.status(404).json({ error: 'Нет получателей с зарегистрированным токеном' });

    const imageWarning = imageUrl ? await checkPushImage(imageUrl) : null;
    const result = await sendBroadcast({ title, body, imageUrl, tokens });
    logger.info({ audience, ...result }, '[PushAdmin] Рассылка отправлена');
    res.json({ ok: true, audience, ...result, ...(imageWarning ? { imageWarning } : {}) });
  } catch (err: any) {
    logger.error({ err }, '[PushAdmin] POST /send упал');
    res.status(500).json({ error: 'Не удалось отправить рассылку', details: String(err?.message ?? err) });
  }
});
