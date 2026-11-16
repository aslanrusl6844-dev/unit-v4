import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runOrderSync, runRekassaShiftClose } from '../../dist/cron/handlers';
import { checkCronSecret } from '../_lib/cronAuth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await runOrderSync();
    // Заодно закрываем смену онлайн-кассы (8:00 по Алматы) — сбой кассы не ломает синхронизацию.
    const rekassa = await runRekassaShiftClose().catch((err: any) => ({ closed: false, error: String(err?.message ?? err) }));
    res.status(200).json({ ok: true, result, rekassa });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
}
