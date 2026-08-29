import { Redis } from 'ioredis';
import { apiEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { createPrisma, createRedisCache, prismaExecutor } from '@tas/db';
import { buildServer, type ComponentState } from './server.js';
import { createRedisRateCounter } from './ratelimit.js';
import { registerEventsRoute } from './routes/events.js';

loadRootEnv();
const env = parseEnv(apiEnvSchema);
const prisma = createPrisma(env.DATABASE_URL);
const executor = prismaExecutor(prisma);

// Общий Redis для кэша резолва и rate limit (ленивое подключение)
const appRedis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const cache = createRedisCache(appRedis);
const rateCounter = createRedisRateCounter(appRedis);

/** TD-001 закрыт (M2): реальный запрос к БД вместо tcp-check. */
export async function dbCheck(): Promise<ComponentState> {
  const rows = await prisma.$queryRaw`SELECT 1`;
  return Array.isArray(rows) && rows.length > 0 ? 'up' : 'down';
}

/** Redis PING свежим соединением. */
export async function queueCheck(redisUrl: string, timeoutMs = 1000): Promise<ComponentState> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  // одноразовое соединение: ошибка сокета обрабатывается через reject connect()
  redis.on('error', () => {});
  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  } finally {
    try {
      redis.disconnect();
    } catch {
      // соединение не установлено — отключать нечего
    }
  }
}

async function main(): Promise<void> {
  const app = await buildServer({
    checks: {
      db: dbCheck,
      queue: () => queueCheck(env.REDIS_URL),
    },
    logger: { level: 'info' },
    routes: (appRef) => {
      registerEventsRoute(appRef, {
        executor,
        cache,
        rateCounter,
        salt: env.ENCRYPTION_KEY,
        tokenFormat: { prefix: env.ATTRIBUTION_TOKEN_PREFIX, length: env.NANOID_LEN },
      });
    },
  });

  await app.listen({ port: env.APP_PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'graceful shutdown');
    await app.close();
    appRedis.disconnect();
    await prisma.$disconnect();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
}

void main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
