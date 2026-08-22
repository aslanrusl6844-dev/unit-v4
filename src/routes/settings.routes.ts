import { Router } from 'express';
import { getKaspiStore, saveKaspiStore, deleteKaspiStore } from '../handlers/kaspiStore';

export const settingsRouter = Router();

settingsRouter.get('/kaspi-store', async (_req, res) => {
  res.json(await getKaspiStore());
});

settingsRouter.post('/kaspi-store', async (req, res) => {
  const result = await saveKaspiStore(req.body);
  res.status(result.status).json(result.body);
});

settingsRouter.delete('/kaspi-store/:id', async (req, res) => {
  const result = await deleteKaspiStore(req.params.id);
  if (result.status === 204) return res.status(204).send();
  res.status(result.status).json(result.body);
});
