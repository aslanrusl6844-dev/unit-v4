import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runOzonBotReport } from '../../dist/cron/handlers';
import { checkCronSecret } from '../_lib/cronAuth';

/** /api/cron/ozon-report?kind=morning|evening — отчёт Озон-менеджера владельцу в Telegram (8:30 и 21:00 по Алматы). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  const kind = req.query.kind === 'evening' ? 'evening' : 'morning';
  try {
    const result = await runOzonBotReport(kind);
    res.status(200).json({ ok: true, kind, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
}
