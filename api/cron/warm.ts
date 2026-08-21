import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runWarmup } from '../../dist/cron/handlers';
import { checkCronSecret } from '../_lib/cronAuth';

/**
 * Отдельный файл = гарантированный маршрут /api/cron/warm у Vercel
 * (в отличие от catch-all api/[...slug].ts, у именных файлов нет никакой
 * неоднозначности в маршрутизации вложенных путей).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await runWarmup();
    res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
}
