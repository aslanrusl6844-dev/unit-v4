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
 * Гарантирует, что в строке подключения есть "pgbouncer=true" и
 * "connection_limit=1" — обязательные параметры для serverless-окружений
 * (Vercel) при подключении через пулер (PgBouncer/Neon pooler). Без них
 * Prisma может пытаться использовать prepared statements, которые
 * PgBouncer в режиме transaction pooling не поддерживает — из-за этого
 * запросы зависают и падают по таймауту (504).
 *
 * Добавляем эти параметры programmatically, а не только через README,
 * чтобы фикс сработал даже если переменная DATABASE_URL в панели Vercel
 * уже задана без них — не нужно ничего руками менять в настройках.
 */
function ensureServerlessSafeUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;

  const hasPgBouncer = /[?&]pgbouncer=/.test(rawUrl);
  const hasConnLimit = /[?&]connection_limit=/.test(rawUrl);
  if (hasPgBouncer && hasConnLimit) return rawUrl;

  const extraParams: string[] = [];
  if (!hasPgBouncer) extraParams.push('pgbouncer=true');
  if (!hasConnLimit) extraParams.push('connection_limit=1');

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
