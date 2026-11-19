import { AGORA_APP_ID } from './live.service';

/**
 * Расход минут Agora за месяц — из их Console REST API (GET /dev/v3/usage).
 * Agora считает в секундах по дням (UTC) и по качеству видео; данные обновляются с задержкой (обычно до суток).
 * Сумма — примерная, по прайсу Agora: 10 000 бесплатных минут в месяц, дальше по тарифам за 1 000 минут.
 */

export const AGORA_FREE_MINUTES = 10_000;

/** Цена за 1 000 минут, $ (agora.io/en/pricing/agora-rtc). */
export const AGORA_PRICE = {
  audio: 0.99,
  hd: 3.99,
  fullHd: 8.99,
  k2: 15.99,
  k4: 35.99,
  recAudio: 1.49,
  recHd: 5.99,
  recFullHd: 13.49,
};

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setAgoraUsageFetch(f: Fetch | null) { fetchImpl = f ?? ((...a) => fetch(...a)); cache.clear(); projectIdCache = null; }

export const agoraUsageConfigured = () => !!(process.env.AGORA_CUSTOMER_ID?.trim() && process.env.AGORA_CUSTOMER_SECRET?.trim());

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${process.env.AGORA_CUSTOMER_ID?.trim()}:${process.env.AGORA_CUSTOMER_SECRET?.trim()}`).toString('base64');
}

async function agoraGet(path: string): Promise<any> {
  const res = await fetchImpl(`https://api.agora.io${path}`, {
    headers: { authorization: authHeader(), 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Agora ${res.status}: ${String(data?.message ?? JSON.stringify(data)).slice(0, 200)}`);
  return data;
}

let projectIdCache: string | null = null;
/** ID проекта Agora по App ID (нужен для запроса расхода). */
async function projectId(): Promise<string> {
  if (projectIdCache) return projectIdCache;
  const d = await agoraGet('/dev/v1/projects');
  const list: any[] = d?.projects ?? [];
  const p = list.find((x) => x?.vendor_key === AGORA_APP_ID) ?? list[0];
  if (!p?.id) throw new Error('В Agora не найден проект с нашим App ID');
  projectIdCache = String(p.id);
  return projectIdCache;
}

const sum = (rows: any[], key: string) => rows.reduce((n, r) => n + (Number(r?.usage?.[key]) || 0), 0);
const min = (sec: number) => Math.round(sec / 60);

export type AgoraUsage = {
  month: string; from: string; to: string;
  minutes: { audio: number; hd: number; fullHd: number; k2: number; k4: number; total: number };
  recording: { audio: number; hd: number; fullHd: number; total: number };
  freeMinutes: number; freeLeft: number; costUsd: number;
  days: Array<{ date: string; minutes: number; recording: number }>;
  updatedAt: string;
};

/** Посчитать стоимость: бесплатные 10 000 минут сначала гасят самые дорогие минуты эфира. */
export function agoraCost(m: AgoraUsage['minutes'], r: AgoraUsage['recording']): { costUsd: number; freeLeft: number } {
  const parts: Array<[number, number]> = [
    [m.k4, AGORA_PRICE.k4], [m.k2, AGORA_PRICE.k2], [m.fullHd, AGORA_PRICE.fullHd], [m.hd, AGORA_PRICE.hd], [m.audio, AGORA_PRICE.audio],
  ];
  let free = AGORA_FREE_MINUTES;
  let cost = 0;
  for (const [n, price] of parts) {
    const used = Math.min(free, n);
    free -= used;
    cost += ((n - used) / 1000) * price;
  }
  cost += (r.audio / 1000) * AGORA_PRICE.recAudio + (r.hd / 1000) * AGORA_PRICE.recHd + (r.fullHd / 1000) * AGORA_PRICE.recFullHd;
  return { costUsd: Math.round(cost * 100) / 100, freeLeft: free };
}

const cache = new Map<string, { at: number; data: AgoraUsage }>();

/** Расход за месяц (YYYY-MM, по UTC — так считает Agora). Кэш 10 минут. */
export async function agoraMonthUsage(month?: string, now = new Date()): Promise<AgoraUsage> {
  const m = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : now.toISOString().slice(0, 7);
  const hit = cache.get(m);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const [y, mo] = m.split('-').map(Number);
  const from = `${m}-01`;
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const to = last < today ? last : today;
  const pid = await projectId();
  const q = (business: string) => agoraGet(`/dev/v3/usage?project_id=${encodeURIComponent(pid)}&from_date=${from}&to_date=${to}&business=${business}`);
  const [rtc, rec] = await Promise.all([q('default'), q('cloudRecording').catch(() => ({ usages: [] }))]);
  const r1: any[] = rtc?.usages ?? [];
  const r2: any[] = rec?.usages ?? [];
  const minutes = {
    audio: min(sum(r1, 'durationAudioAll')),
    hd: min(sum(r1, 'durationVideoHd')),
    fullHd: min(sum(r1, 'durationVideoHdp') + sum(r1, 'durationVideo1080P')),
    k2: min(sum(r1, 'durationVideo2K')),
    k4: min(sum(r1, 'durationVideo4K')),
    total: 0,
  };
  minutes.total = minutes.audio + minutes.hd + minutes.fullHd + minutes.k2 + minutes.k4;
  const recording = {
    audio: min(sum(r2, 'durationAudioAll')),
    hd: min(sum(r2, 'durationVideoHd')),
    fullHd: min(sum(r2, 'durationVideoHdp') + sum(r2, 'durationVideo1080P') + sum(r2, 'durationVideo2K') + sum(r2, 'durationVideo4K')),
    total: 0,
  };
  recording.total = recording.audio + recording.hd + recording.fullHd;
  const dayKey = (d: any) => String(typeof d === 'number' ? new Date(d * 1000).toISOString() : d ?? '').slice(0, 10);
  const daySec = (u: any) => ['durationAudioAll', 'durationVideoHd', 'durationVideoHdp', 'durationVideo1080P', 'durationVideo2K', 'durationVideo4K'].reduce((n, k) => n + (Number(u?.[k]) || 0), 0);
  const days = new Map<string, { date: string; minutes: number; recording: number }>();
  for (const r of r1) { const k = dayKey(r.date); const d = days.get(k) ?? { date: k, minutes: 0, recording: 0 }; d.minutes += min(daySec(r.usage)); days.set(k, d); }
  for (const r of r2) { const k = dayKey(r.date); const d = days.get(k) ?? { date: k, minutes: 0, recording: 0 }; d.recording += min(daySec(r.usage)); days.set(k, d); }
  const { costUsd, freeLeft } = agoraCost(minutes, recording);
  const data: AgoraUsage = {
    month: m, from, to, minutes, recording, freeMinutes: AGORA_FREE_MINUTES, freeLeft, costUsd,
    days: Array.from(days.values()).filter((d) => d.minutes || d.recording).sort((a, b) => a.date.localeCompare(b.date)),
    updatedAt: new Date().toISOString(),
  };
  cache.set(m, { at: Date.now(), data });
  return data;
}
