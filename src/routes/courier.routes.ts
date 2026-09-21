import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const courierRouter = Router();

// Тот же ключ приложения — курьер тоже работает через приложение/его API.
courierRouter.use((req, res, next) => {
  if (!env.shopAppKey) {
    return res.status(503).json({ error: 'SHOP_APP_KEY не настроен на сервере' });
  }
  const key = req.header('x-app-key');
  if (key !== env.shopAppKey) {
    return res.status(401).json({ error: 'Неверный или отсутствующий заголовок x-app-key' });
  }
  next();
});

const deliverSchema = z.object({
  number: z.string().min(1), // номер заказа
  pickupCode: z.string().min(1), // код выдачи, который называет покупатель
});

/**
 * Подтверждение выдачи — номер заказа + код выдачи (4 цифры), который
 * покупатель называет курьеру/на ПВЗ. Остаток товара уже был списан на
 * этапе оплаты (paid) — здесь только меняется статус на delivered.
 */
courierRouter.post('/deliver', async (req, res) => {
  const parsed = deliverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Укажите номер заказа и код выдачи' });

  try {
    const order = await prisma.shopOrder.findUnique({ where: { number: parsed.data.number } });
    if (!order) return res.status(404).json({ error: 'Заказ с таким номером не найден' });
    if (order.pickupCode !== parsed.data.pickupCode) {
      return res.status(400).json({ error: 'Код выдачи не совпадает' });
    }
    if (order.status === 'delivered') {
      return res.status(409).json({ error: 'Заказ уже отмечен как выданный' });
    }
    if (order.status !== 'paid' && order.status !== 'assembled') {
      return res.status(409).json({ error: `Заказ в статусе "${order.status}" — сначала должен быть оплачен` });
    }

    await prisma.shopOrder.update({ where: { id: order.id }, data: { status: 'delivered', deliveredAt: new Date() } });
    // Синхронизируем и связанный Order (для отчётности) в тот же статус.
    await prisma.order.updateMany({ where: { marketplace: 'APP', externalId: order.number }, data: { status: 'delivered' } });

    res.json({ ok: true, status: 'delivered' });
  } catch (err: any) {
    logger.error({ err }, '[Courier API] Ошибка подтверждения выдачи');
    res.status(500).json({ error: 'Не удалось подтвердить выдачу', details: String(err?.message ?? err) });
  }
});
