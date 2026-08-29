import net from 'node:net';
import { Redis } from 'ioredis';
import { apiEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { buildServer, type ComponentState } from './server.js';

loadRootEnv();
const env = parseEnv(apiEnvSchema);

/** TCP-check БД (TD-001: заменить на SELECT 1 через Prisma в M2). */
export function dbTcpCheck(databaseUrl: string, timeoutMs = 1000): Promise<ComponentState> {
  const url = new URL(databaseUrl);
  const port = url.port ? Number(url.port) : 5432;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve('up');
    });
    socket.once('error', () => {
      socket.destroy();
      resolve('down');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('down');
    });
  });
}

/** Redis PING свежим соединением (без зависания на ретраях). */
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
      db: () => dbTcpCheck(env.DATABASE_URL),
      queue: () => queueCheck(env.REDIS_URL),
    },
    logger: { level: env.NODE_ENV === 'development' ? 'info' : 'info' },
  });

  await app.listen({ port: env.APP_PORT, host: '0.0.0.0' });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'graceful shutdown');
    await app.close();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
}

void main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
