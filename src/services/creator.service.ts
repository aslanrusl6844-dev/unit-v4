/**
 * Креаторы My Market Live (шаг 1): заявка из приложения («Я креатор» → анкета),
 * одобрение в админке с процентом, личный код креатора.
 * Начисления, шортс и эфиры — следующие шаги.
 */
import { randomInt } from 'crypto';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { sendBroadcast } from './pushBroadcast.service';

export const CREATOR_MIN_PERCENT = 1;
export const CREATOR_MAX_PERCENT = 50;
export const CREATOR_DEFAULT_PERCENT = 7;

/** Процент креатора: число 1..50 (до 0.5), иначе null. */
export function normalizePercent(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 2) / 2;
  if (r < CREATOR_MIN_PERCENT || r > CREATOR_MAX_PERCENT) return null;
  return r;
}

// Без похожих символов (0/O, 1/I/L), чтобы код легко продиктовать.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCreatorCode(): string {
  let s = '';
  for (let i = 0; i < 5; i += 1) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `MM-${s}`;
}

export async function uniqueCreatorCode(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const code = randomCreatorCode();
    const taken = await prisma.creator.findUnique({ where: { code } });
    if (!taken) return code;
  }
  throw new Error('Не удалось подобрать свободный код креатора');
}

export function parseAnswers(raw: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Пуш покупателю-креатору (по телефону). Ошибки не мешают основному действию. */
export async function pushCreator(phone: string, title: string, body: string): Promise<void> {
  try {
    const device = await prisma.shopCustomerPushToken.findUnique({ where: { phone } });
    if (!device?.token) return;
    await sendBroadcast({ title, body, tokens: [device.token], data: { type: 'creator' } });
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, '[Creator] пуш не ушёл');
  }
}

/** Одобрить заявку: создаёт (или обновляет) креатора с процентом и личным кодом. */
export async function approveApplication(id: string, percent: number) {
  const app = await prisma.creatorApplication.findUnique({ where: { id } });
  if (!app) return null;
  const wasApproved = app.status === 'approved';
  await prisma.creatorApplication.update({ where: { id }, data: { status: 'approved', reviewedAt: new Date(), rejectReason: null } });
  const existing = await prisma.creator.findUnique({ where: { phone: app.phone } });
  const creator = existing
    ? await prisma.creator.update({ where: { id: existing.id }, data: { percent, active: true, name: app.name, applicationId: app.id } })
    : await prisma.creator.create({ data: { phone: app.phone, name: app.name, code: await uniqueCreatorCode(), percent, active: true, applicationId: app.id } });
  if (!wasApproved) {
    await pushCreator(app.phone, 'Вы креатор My Market! 🎉', `Заявка одобрена. Ваш код ${creator.code}, процент с продаж — ${percent}%.`);
  }
  return creator;
}
