import { PrismaClient } from '@prisma/client';

// Singleton, чтобы избежать открытия множества подключений при hot-reload в dev-режиме.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}
