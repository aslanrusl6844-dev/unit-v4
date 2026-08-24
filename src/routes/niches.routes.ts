import { Router } from 'express';
import { z } from 'zod';
import { analyzeNiche } from '../services/niche.service';
import { logger } from '../utils/logger';

export const nichesRouter = Router();

const analyzeSchema = z.object({
  input: z.string().min(3, 'Вставьте ссылку на товар Kaspi или артикул'),
});

nichesRouter.post('/analyze', async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await analyzeNiche(parsed.data.input);
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, '[Ниши] Ошибка анализа');
    res.status(500).json({ error: 'Не удалось проанализировать нишу', details: String(err?.message ?? err) });
  }
});
