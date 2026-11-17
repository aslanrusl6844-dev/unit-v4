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
    var __prisma: PrismaClient | undefined;
}
export declare const prisma: PrismaClient<import(".prisma/client").Prisma.PrismaClientOptions, never, import("@prisma/client/runtime/library").DefaultArgs>;
