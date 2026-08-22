import { z } from 'zod';
import { prisma } from '../db/prisma';

/** Логика подключения Ozon — по образцу src/handlers/kaspiStore.ts. */

export const ozonStoreSchema = z.object({
  clientId: z.string().min(1, 'Укажите Client-Id'),
  apiKey: z.string().min(5, 'Api-Key обязателен и должен быть похож на настоящий'),
});

export async function getOzonStore() {
  try {
    const store = await prisma.ozonStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!store) return null;
    // Api-Key целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
    return { ...store, apiKey: undefined, apiKeyMasked: `••••${store.apiKey.slice(-4)}` };
  } catch (err: any) {
    throw new Error(`Не удалось получить магазин Ozon: ${String(err?.message ?? err)}`);
  }
}

export async function saveOzonStore(body: unknown) {
  const parsed = ozonStoreSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: parsed.error.flatten() } };
  }

  try {
    const existing = await prisma.ozonStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    const store = existing
      ? await prisma.ozonStore.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.ozonStore.create({ data: parsed.data });

    return {
      status: 201 as const,
      body: { ...store, apiKey: undefined, apiKeyMasked: `••••${store.apiKey.slice(-4)}` },
    };
  } catch (err: any) {
    return { status: 500 as const, body: { error: 'Не удалось сохранить магазин Ozon', details: String(err?.message ?? err) } };
  }
}
