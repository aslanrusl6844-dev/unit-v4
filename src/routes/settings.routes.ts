import { Router } from 'express';
import { getKaspiStore, saveKaspiStore, deleteKaspiStore } from '../handlers/kaspiStore';
import { getOzonStore, saveOzonStore } from '../handlers/ozonStore';
import { getWbStore, saveWbStore } from '../handlers/wbStore';

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

settingsRouter.get('/ozon-store', async (_req, res) => {
  res.json(await getOzonStore());
});

settingsRouter.post('/ozon-store', async (req, res) => {
  const result = await saveOzonStore(req.body);
  res.status(result.status).json(result.body);
});

settingsRouter.get('/wb-store', async (_req, res) => {
  res.json(await getWbStore());
});

settingsRouter.post('/wb-store', async (req, res) => {
  const result = await saveWbStore(req.body);
  res.status(result.status).json(result.body);
});
