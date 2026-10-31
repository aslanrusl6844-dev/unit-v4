import { Router } from 'express';
import { prisma } from '../db/prisma';

export const adsRouter = Router();

/**
 * Статус подключений для страницы «Реклама» и блока Wordstat.
 * Google Ads и Яндекс Директ пока не подключены (нужны аккаунты, доступ к API
 * и токены) — честно показываем «не подключено», а не пустые цифры.
 */
adsRouter.get('/status', async (_req, res) => {
  let wordstat = false;
  try {
    wordstat = Boolean(await prisma.yandexCloudStore.findFirst({ select: { id: true } }));
  } catch {
    wordstat = false;
  }
  res.json({
    wordstat: { configured: wordstat },
    googleAds: { configured: false },
    yandexDirect: { configured: false },
  });
});
