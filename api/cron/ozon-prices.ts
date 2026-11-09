import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runOzonPrices } from '../../dist/cron/handlers';
import { prisma } from '../../dist/db/prisma';
import { checkCronSecret } from '../_lib/cronAuth';

/**
 * Живые цены Ozon раз в 5 минут — вызывает GitHub Actions (.github/workflows/ozon-prices.yml).
 * Репозиторий публичный, секрет туда не положить, поэтому без секрета задача запускается
 * не чаще раза в 4 минуты (отметка в таблице JobMark) — дёргать её чаще бессмысленно.
 * Сама задача только читает цены у Ozon и пишет их в базу — ничего опасного.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!checkCronSecret(req)) {
      const since = new Date(Date.now() - 4 * 60 * 1000);
      const claimed = await prisma.$executeRaw`
        INSERT INTO "JobMark" ("id", "lastAt") VALUES ('ozon-prices', now())
        ON CONFLICT ("id") DO UPDATE SET "lastAt" = now() WHERE "JobMark"."lastAt" < ${since}`;
      if (!claimed) return res.status(200).json({ ok: true, skipped: 'recent' });
    }
    const result = await runOzonPrices();
    res.status(200).json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
}
