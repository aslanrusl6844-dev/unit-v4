import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runCartReminder } from '../../dist/cron/handlers';
import { checkCronSecret } from '../_lib/cronAuth';

/** /api/cron/cart-reminder — пуш «вы оставили товар в корзине» (через 24 ч). Запускать раз в час (внешний планировщик) или раз в сутки (Vercel Cron). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await runCartReminder();
    res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
}
