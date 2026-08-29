import { Redis } from 'ioredis';
import { createPrisma } from '@tas/db/client';
import { createRedisCache, prismaExecutor, type KvCache, type SqlExecutor } from '@tas/db/services';
import { getServerConfig } from './config';

/**
 * Серверные зависимости bridge: SQL-исполнитель + Redis-кэш.
 * Ленивая инициализация (первый запрос); при недоступности БД/Redis
 * bridge деградирует изящно — страница всё равно рендерится (AN-15).
 */
let cachedDeps: { executor: SqlExecutor; cache: KvCache } | undefined;

export function getServerDeps(): { executor: SqlExecutor; cache: KvCache } {
  if (!cachedDeps) {
    const cfg = getServerConfig();
    const prisma = createPrisma(cfg.databaseUrl);
    const redis = new Redis(cfg.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on('error', () => {}); // ошибки соединения не роняют рендер
    cachedDeps = { executor: prismaExecutor(prisma), cache: createRedisCache(redis) };
  }
  return cachedDeps;
}
