import { Redis } from 'ioredis';
import { botEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { createPrisma } from '@tas/db';
import { buildServer, type ComponentState } from './server.js';

loadRootEnv();
const env = parseEnv(botEnvSchema);
const prisma = createPrisma(env.DATABASE_URL);

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
  });

  // AN-10: в prod наружу торчит только 443; Caddy → bot:4100 внутри сети.
  await app.listen({ port: env.BOT_PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'graceful shutdown');
    await app.close();
    await prisma.$disconnect();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
}

void main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
