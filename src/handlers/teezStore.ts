import { z } from 'zod';
import { prisma } from '../db/prisma';
import { teezClient } from '../integrations/teez.client';

/** Логика подключения Teez — по образцу src/handlers/wbStore.ts / ozonStore.ts. */

export const teezStoreSchema = z.object({
  clientId: z.string().trim().min(1, 'Client ID обязателен (виден в таблице «Ключи API» в кабинете Teez)'),
  clientSecret: z.string().trim().min(8, 'Ключ API обязателен (не короче 8 символов; показывается один раз при создании)'),
});

function present(store: { clientId: string; clientSecret: string } & Record<string, unknown>) {
  // Ключ целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
  return { ...store, clientSecret: undefined, clientSecretMasked: `••••${store.clientSecret.slice(-4)}` };
}

export async function getTeezStore() {
  try {
    const store = await prisma.teezStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    return store ? present(store) : null;
  } catch (err: any) {
    throw new Error(`Не удалось получить магазин Teez: ${String(err?.message ?? err)}`);
  }
}

export async function saveTeezStore(body: unknown) {
  const parsed = teezStoreSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: parsed.error.flatten() } };
  }

  try {
    const existing = await prisma.teezStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    const store = existing
      ? await prisma.teezStore.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.teezStore.create({ data: parsed.data });

    // Сразу проверяем ключи: получилось ли войти. Сохранение от результата не зависит.
    teezClient.resetToken();
    const connection = await teezClient.testConnection(parsed.data);

    return { status: 201 as const, body: { ...present(store), connection } };
  } catch (err: any) {
    return { status: 500 as const, body: { error: 'Не удалось сохранить магазин Teez', details: String(err?.message ?? err) } };
  }
}
