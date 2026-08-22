import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getKaspiStore, saveKaspiStore, deleteKaspiStore } from '../../dist/handlers/kaspiStore';

/**
 * Отдельный файл = гарантированный маршрут /api/settings/kaspi-store у
 * Vercel (в отличие от catch-all api/[...slug].ts, у именных файлов нет
 * никакой неоднозначности в маршрутизации вложенных путей). Тот же приём,
 * что уже решил идентичную проблему с /api/cron/*.
 *
 * Поддерживает GET (получить текущий магазин), POST (создать/обновить) и
 * DELETE (удалить по id — передайте ?id=... в query).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    return res.status(200).json(await getKaspiStore());
  }

  if (req.method === 'POST') {
    const result = await saveKaspiStore(req.body);
    return res.status(result.status).json(result.body);
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'Не указан id магазина (?id=...)' });
    const result = await deleteKaspiStore(id);
    if (result.status === 204) return res.status(204).send(null);
    return res.status(result.status).json(result.body);
  }

  return res.status(405).json({ error: 'Метод не поддерживается' });
}
