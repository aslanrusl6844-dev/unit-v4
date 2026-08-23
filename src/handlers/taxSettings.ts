import { z } from 'zod';
import { prisma } from '../db/prisma';

/**
 * Ставка налога ИП — по умолчанию 4% (упрощёнка: налог считается от
 * ВЫРУЧКИ, не от прибыли). Одна запись на сервер, настраивается в разделе
 * «Настройки».
 */

export const taxSettingsSchema = z.object({
  ratePct: z.number().min(0).max(100),
});

export async function getTaxSettings() {
  const settings = await prisma.taxSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  return { ratePct: settings?.ratePct ?? 4 };
}

/** Только число ставки — для использования внутри analytics.service.ts,
 *  без лишних полей. */
export async function getTaxRatePct(): Promise<number> {
  const settings = await prisma.taxSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
  return settings?.ratePct ?? 4;
}

export async function saveTaxSettings(body: unknown) {
  const parsed = taxSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400 as const, body: { error: parsed.error.flatten() } };
  }

  try {
    const existing = await prisma.taxSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
    const settings = existing
      ? await prisma.taxSettings.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.taxSettings.create({ data: parsed.data });
    return { status: 201 as const, body: settings };
  } catch (err: any) {
    return { status: 500 as const, body: { error: 'Не удалось сохранить ставку налога', details: String(err?.message ?? err) } };
  }
}
