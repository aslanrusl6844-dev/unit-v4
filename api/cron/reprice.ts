import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runReprice } from '../../dist/cron/handlers';
import { checkCronSecret } from '../_lib/cronAuth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!checkCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const results = await runReprice();
    res.status(200).json({ ok: true, results });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
}
