import { z } from 'zod';
import { prisma } from '../db/prisma';

/** Подключение Yandex Cloud (Wordstat) — по образцу src/handlers/teezStore.ts. */

export const yandexCloudSchema = z.object({
  folderId: z.string().trim().min(5, 'Folder ID обязателен (идентификатор каталога в Yandex Cloud)'),
  apiKey: z.string().trim().min(10, 'API-ключ обязателен (показывается один раз при создании)'),
});

function present(store: { folderId: string; apiKey: string } & Record<string, unknown>) {
  // Ключ целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
  return { ...store, apiKey: undefined, apiKeyMasked: `••••${store.apiKey.slice(-4)}` };
}

export async function getYandexCloudStore() {
  try {
    const store = await prisma.yandexCloudStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    return store ? present(store) : null;
  } catch (err: any) {
    throw new Error(`Не удалось получить настройки Yandex Cloud: ${String(err?.message ?? err)}`);
  }
}

export async function saveYandexCloudStore(body: unknown) {
  const parsed = yandexCloudSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: parsed.error.flatten() } };
  }
  try {
    const existing = await prisma.yandexCloudStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    const store = existing
      ? await prisma.yandexCloudStore.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.yandexCloudStore.create({ data: parsed.data });
    return { status: 201 as const, body: present(store) };
  } catch (err: any) {
    return { status: 500 as const, body: { error: 'Не удалось сохранить настройки Yandex Cloud', details: String(err?.message ?? err) } };
  }
}
