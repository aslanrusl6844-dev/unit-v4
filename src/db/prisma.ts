import { PrismaClient } from '@prisma/client';

/**
 * Singleton-подключение к базе данных. Критично для Vercel (serverless):
 * без кэширования каждый вызов функции создавал бы НОВОЕ подключение к
 * Neon — на бесплатном тарифе там очень маленький лимит одновременных
 * подключений, и они быстро заканчивались, из-за чего запросы зависали
 * в ожидании и падали по таймауту (504 Gateway Timeout).
 *
 * ВАЖНО: раньше здесь было условие "кэшировать только не в production" —
 * оно предназначалось для локальной разработки (чтобы hot-reload не плодил
 * подключения), но на Vercel NODE_ENV всегда "production", так что это
 * условие на проде НИКОГДА не срабатывало, и кэш не работал вообще. Теперь
 * кэшируем всегда, независимо от окружения.
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

/**
 * Гарантирует наличие важных для serverless параметров в строке подключения:
 * - pgbouncer=true / connection_limit=1 — совместимость с пулером Neon
 * - connect_timeout=10 — если подключение к базе вообще не устанавливается
 *   (неверный адрес, сеть, файрвол) — Postgres должен сказать об этом
 *   через 10 секунд явной ошибкой, а не зависать бесконечно тихо.
 * - pool_timeout=10 — максимум ожидания свободного подключения из пула
 *   Prisma, тоже с явной ошибкой вместо тихого зависания.
 *
 * Добавляем эти параметры programmatically, а не только через README,
 * чтобы фикс сработал даже если переменная DATABASE_URL в панели Vercel
 * уже задана без них — не нужно ничего руками менять в настройках.
 */
function ensureServerlessSafeUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;

  const extraParams: string[] = [];
  if (!/[?&]pgbouncer=/.test(rawUrl)) extraParams.push('pgbouncer=true');
  if (!/[?&]connection_limit=/.test(rawUrl)) extraParams.push('connection_limit=1');
  if (!/[?&]connect_timeout=/.test(rawUrl)) extraParams.push('connect_timeout=10');
  if (!/[?&]pool_timeout=/.test(rawUrl)) extraParams.push('pool_timeout=10');

  if (extraParams.length === 0) return rawUrl;

  const separator = rawUrl.includes('?') ? '&' : '?';
  return `${rawUrl}${separator}${extraParams.join('&')}`;
}

const datasourceUrl = ensureServerlessSafeUrl(process.env.DATABASE_URL);

export const prisma =
  global.__prisma ??
  new PrismaClient(
    datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : undefined,
  );

global.__prisma = prisma;

/**
 * Диагностика: логируем длительность каждого запроса к базе данных.
 * Медленные запросы (>1с) и любые ошибки попадают в Runtime Logs Vercel
 * с точным временем — это единственный способ понять, ЧТО именно
 * зависает: само подключение к Neon, конкретный запрос, или что-то ещё.
 */
if (!(global as any).__prismaLoggingAttached) {
  prisma.$use(async (params, next) => {
    const startedAt = Date.now();
    try {
      const result = await next(params);
      const ms = Date.now() - startedAt;
      if (ms > 1000) {
        // eslint-disable-next-line no-console
        console.warn(`🐢 [DB] Медленный запрос: ${params.model}.${params.action} — ${ms}мс`);
      }
      return result;
    } catch (err) {
      const ms = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.error(`❌ [DB] Ошибка запроса: ${params.model}.${params.action} — ${ms}мс —`, err);
      throw err;
    }
  });
  (global as any).__prismaLoggingAttached = true;
}
