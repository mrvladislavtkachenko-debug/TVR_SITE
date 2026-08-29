import { createRequire } from 'node:module';
import type { PrismaClient } from '@prisma/client';

export type { PrismaClient, Prisma } from '@prisma/client';

type PrismaClientModule = { PrismaClient: new (options?: { datasourceUrl?: string }) => PrismaClient };

/**
 * Фабрика PrismaClient. Приложение создаёт один инстанс на процесс.
 * Вызов ПОСЛЕ загрузки env (loadRootEnv + parseEnv), либо с явным URL.
 *
 * AN-17: подключение через runtime require (createRequire), а не статический
 * import: бандлеры (Next webpack) иначе тянут @prisma/client в бандл, где
 * генерация .prisma/client недоступна. Типы — статически (type-only import),
 * инстанс — в рантайме из node_modules (сгенерированный клиент или заглушка
 * среды разработки).
 */
const runtimeRequire = createRequire(import.meta.url);

export function createPrisma(databaseUrl?: string): PrismaClient {
  const { PrismaClient: PrismaClientCtor } = runtimeRequire('@prisma/client') as PrismaClientModule;
  return new PrismaClientCtor(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
}
