/**
 * My Market Live: шортс креаторов и прямые эфиры (Agora).
 * Видео — в Cloudflare R2, эфир — Agora (токены выдаёт сервер), чат эфира — у нас в базе.
 */
import { randomBytes } from 'crypto';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { prisma } from '../db/prisma';

/** App ID проекта Agora не секрет (он и так есть в приложении); сертификат — только в переменных Vercel. */
export const AGORA_APP_ID = process.env.AGORA_APP_ID?.trim() || 'eddfb3532542449897a94b234761dbc8';
export const agoraConfigured = () => !!process.env.AGORA_APP_CERTIFICATE?.trim();

/** Эфир без отметки креатора дольше этого — считается завершённым (приложение закрыли, пропала сеть). */
export const LIVE_STALE_MS = 90_000;
export const TOKEN_TTL_S = 4 * 60 * 60;
export const MAX_SKUS = 10;

export function agoraToken(channel: string, role: 'host' | 'audience'): string {
  const cert = process.env.AGORA_APP_CERTIFICATE?.trim();
  if (!cert) throw new Error('AGORA_APP_CERTIFICATE не настроен');
  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID, cert, channel, 0,
    role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
    TOKEN_TTL_S, TOKEN_TTL_S,
  );
}

export function newChannel(): string {
  return `mm-${randomBytes(6).toString('hex')}`;
}

export function cleanSkus(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.map((s) => String(s ?? '').trim()).filter((s) => s && s.length <= 60);
  return Array.from(new Set(out)).slice(0, MAX_SKUS);
}

export function parseSkus(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

type StreamRow = { status: string; lastBeatAt?: Date | null; startedAt?: Date | null };

/** Эфир действительно идёт: статус live и креатор недавно отмечался. */
export function isOnAir(s: StreamRow, now = Date.now()): boolean {
  if (s.status !== 'live') return false;
  const beat = s.lastBeatAt ?? s.startedAt;
  return !!beat && now - new Date(beat).getTime() < LIVE_STALE_MS;
}

/** Активный креатор по телефону (или null). */
export async function activeCreatorByPhone(phone: string) {
  const c = await prisma.creator.findUnique({ where: { phone } });
  return c && c.active ? c : null;
}

/** Закрывает «зависшие» эфиры (креатор пропал) — вызывается при чтении списков. */
export async function closeStaleStreams(now = Date.now()): Promise<void> {
  await prisma.liveStream.updateMany({
    where: { status: 'live', lastBeatAt: { lt: new Date(now - LIVE_STALE_MS) } },
    data: { status: 'ended', endedAt: new Date(now) },
  });
}

export function videoDto(v: any, creatorName: string, liked = false) {
  return {
    id: v.id, title: v.title, videoUrl: v.videoUrl, skus: parseSkus(v.skus), likes: v.likes, views: v.views,
    status: v.status, creatorName, liked, createdAt: v.createdAt,
  };
}

export function streamDto(s: any, creatorName: string) {
  return {
    id: s.id, title: s.title, status: isOnAir(s) ? 'live' : s.status === 'live' ? 'ended' : s.status,
    skus: parseSkus(s.skus), scheduledAt: s.scheduledAt, startedAt: s.startedAt, endedAt: s.endedAt, creatorName,
  };
}

/** Имена креаторов одним запросом. */
export async function creatorNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return new Map();
  const rows: Array<{ id: string; name: string }> = await prisma.creator.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}
