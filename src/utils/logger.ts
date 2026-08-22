import pino from 'pino';
import { env } from '../config/env';

/**
 * КРИТИЧЕСКИ ВАЖНО для Vercel: pino-pretty работает через отдельный
 * worker-поток (worker_threads), которому нужно подгрузить отдельный файл
 * транспорта по пути. В СОБРАННОЙ (esbuild-бандл) serverless-функции всё
 * упаковано в один файл — отдельного файла транспорта там нет, и попытка
 * его запустить может упасть с необработанным исключением ПРЯМО ПРИ
 * ИМПОРТЕ этого модуля (pino() вызывается на верхнем уровне). А logger
 * импортируется практически всеми файлами проекта — значит, крах здесь
 * рушит вообще весь сайт, для любой страницы.
 *
 * Поэтому pino-pretty используем ТОЛЬКО локально (npm run dev). На Vercel —
 * обычный pino без транспорта: пишет JSON-строками, это чуть менее красиво
 * в логах, зато гарантированно не может уронить импорт модуля.
 */
const isServerless = Boolean(process.env.VERCEL);

function createLogger() {
  try {
    return pino(
      isServerless
        ? { level: env.nodeEnv === 'production' ? 'info' : 'debug' }
        : {
            level: env.nodeEnv === 'production' ? 'info' : 'debug',
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss',
                ignore: 'pid,hostname',
              },
            },
          },
    );
  } catch (err) {
    // Последний рубеж: если даже "голый" pino() не создался — не роняем
    // импорт модуля, а подменяем на простой console.* с тем же интерфейсом
    // (info/warn/error/debug), которого достаточно для всего проекта.
    // eslint-disable-next-line no-console
    console.error('⚠️ Не удалось создать pino-логгер, используется console как запасной вариант:', err);
    const fallback = {
      info: (...args: any[]) => console.log('[INFO]', ...args),
      warn: (...args: any[]) => console.warn('[WARN]', ...args),
      error: (...args: any[]) => console.error('[ERROR]', ...args),
      debug: (...args: any[]) => console.debug('[DEBUG]', ...args),
    };
    return fallback as any;
  }
}

export const logger = createLogger();
