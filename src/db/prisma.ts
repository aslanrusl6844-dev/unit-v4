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

/**
 * КРИТИЧЕСКИ ВАЖНО: этот файл импортируется практически всеми роутами.
 * Если "new PrismaClient()" здесь бросит исключение — это происходит на
 * этапе ЗАГРУЗКИ МОДУЛЯ, ДО того, как успевает сработать хоть один
 * try/catch внутри обработчика запроса. Результат — крах ВСЕЙ функции на
 * Vercel (500 FUNCTION_INVOCATION_FAILED) для АБСОЛЮТНО ЛЮБОЙ страницы
 * сайта, даже той, что базу вообще не использует.
 *
 * Поэтому конструктор обязательно в try/catch. Если что-то пошло не так —
 * не роняем импорт модуля, а создаём "заглушку", которая кинет понятную
 * ошибку ТОЛЬКО в момент реального обращения к базе (prisma.product.findMany()
 * и т.п.) — и эта ошибка уже будет поймана существующими try/catch в роутах.
 */
function createPrismaClient(): PrismaClient {
  try {
    return new PrismaClient(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : undefined);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('⚠️ Не удалось создать PrismaClient при старте:', err?.message ?? err);
    const lazyError = new Error(
      `База данных недоступна: ${String(err?.message ?? err)}. Проверьте DATABASE_URL в Environment Variables и что миграции применены.`,
    );
    // Proxy бросает ошибку только при попытке РЕАЛЬНО воспользоваться
    // клиентом (prisma.product...), а не при простом импорте файла.
    return new Proxy({}, {
      get() {
        throw lazyError;
      },
    }) as PrismaClient;
  }
}

export const prisma = global.__prisma ?? createPrismaClient();

global.__prisma = prisma;
