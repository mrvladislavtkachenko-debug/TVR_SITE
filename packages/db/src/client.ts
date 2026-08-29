import { PrismaClient } from '@prisma/client';

export type { PrismaClient, Prisma } from '@prisma/client';

/**
 * Фабрика PrismaClient. Приложение создаёт один инстанс на процесс.
 * Вызов ПОСЛЕ загрузки env (loadRootEnv + parseEnv), либо с явным URL.
 */
export function createPrisma(databaseUrl?: string): PrismaClient {
  return new PrismaClient(
    databaseUrl ? { datasourceUrl: databaseUrl } : undefined,
  );
}
