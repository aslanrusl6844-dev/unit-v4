import { z } from 'zod';
import { prisma } from '../db/prisma';

/**
 * Логика вынесена из Express-роута в обычные функции, чтобы её могли
 * использовать ДВА разных входа:
 *  - src/routes/settings.routes.ts — обычный Express-роут (через catch-all
 *    api/[...slug].ts, для локальной разработки и как основной путь);
 *  - api/settings/kaspi-store.ts — ОТДЕЛЬНЫЙ файл-маршрут на Vercel,
 *    страховка на случай проблем с маршрутизацией catch-all для этого
 *    конкретного пути (тот же приём, что уже решил проблему с /api/cron/*).
 */

export const kaspiStoreSchema = z.object({
  name: z.string().min(1, 'Укажите название магазина'),
  bin: z.string().optional().nullable(),
  contactPhone: z.string().optional().nullable(),
  contactEmail: z.string().optional().nullable(),
  apiToken: z.string().min(10, 'Токен обязателен и должен быть похож на настоящий'),
  merchantUid: z.string().optional().nullable(),
});

export async function getKaspiStore() {
  const store = await prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!store) return null;
  // Токен целиком не отдаём — только последние 4 символа, для подтверждения сохранения.
  return { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` };
}

export async function saveKaspiStore(body: unknown) {
  const parsed = kaspiStoreSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: parsed.error.flatten() } };
  }

  try {
    const existing = await prisma.kaspiStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    const store = existing
      ? await prisma.kaspiStore.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.kaspiStore.create({ data: parsed.data });

    return {
      status: 201 as const,
      body: { ...store, apiToken: undefined, apiTokenMasked: `••••${store.apiToken.slice(-4)}` },
    };
  } catch (err: any) {
    return { status: 500 as const, body: { error: 'Не удалось сохранить магазин', details: String(err?.message ?? err) } };
  }
}

export async function deleteKaspiStore(id: string) {
  try {
    await prisma.kaspiStore.delete({ where: { id } });
    return { status: 204 as const, body: null };
  } catch {
    return { status: 404 as const, body: { error: 'Магазин не найден' } };
  }
}
