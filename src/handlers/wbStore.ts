import { z } from 'zod';
import { prisma } from '../db/prisma';

/** Логика подключения Wildberries — по образцу src/handlers/ozonStore.ts. */

export const wbStoreSchema = z.object({
  apiToken: z.string().min(10, 'API-ключ обязателен и должен быть похож на настоящий (обычно это длинный JWT-токен)'),
});

export async function getWbStore() {
  try {
    const store = await prisma.wbStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!store) return null;
    // Токен целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
    return { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` };
  } catch (err: any) {
    throw new Error(`Не удалось получить магазин WB: ${String(err?.message ?? err)}`);
  }
}

export async function saveWbStore(body: unknown) {
  const parsed = wbStoreSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: parsed.error.flatten() } };
  }

  try {
    const existing = await prisma.wbStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    const store = existing
      ? await prisma.wbStore.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.wbStore.create({ data: parsed.data });

    return {
      status: 201 as const,
      body: { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` },
    };
  } catch (err: any) {
    return { status: 500 as const, body: { error: 'Не удалось сохранить магазин WB', details: String(err?.message ?? err) } };
  }
}
