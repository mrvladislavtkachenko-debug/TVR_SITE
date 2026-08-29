import { Redis } from 'ioredis';
import { botEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { createPrisma } from '@tas/db/client';
import { createRedisCache, markUpdateProcessed, prismaExecutor } from '@tas/db/services';
import { buildServer, type ComponentState } from './server.js';
import { registerWebhookRoute } from './webhook.js';
import { UpdatePipeline, type BotLogger } from './pipeline.js';
import { createBot, createTransport } from './telegram.js';
import { registerBotHandlers } from './handlers.js';
import { createDbTemplateStore } from './templates.js';
import { OutboxSender } from './outboxSender.js';
import type { Update } from 'grammy/types';

loadRootEnv();
const env = parseEnv(botEnvSchema);
const prisma = createPrisma(env.DATABASE_URL);
const executor = prismaExecutor(prisma);

// Кэш резолва tracking_links (60s, вкл. негативный — контракт M3)
const appRedis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const cache = createRedisCache(appRedis);

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

/** JSON-логи без содержимого переписки (§16.3): только идентификаторы. */
const botLogger: BotLogger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

async function main(): Promise<void> {
  await appRedis.connect();

  // grammY: маршрутизация update + клиент Bot API (§20, §39.7)
  const bot = createBot(env.TELEGRAM_BOT_TOKEN);
  const transport = createTransport(bot);

  const templates = createDbTemplateStore(executor);
  registerBotHandlers(bot, {
    executor,
    cache,
    templates,
    transport,
    leadMagnet: { url: env.LEAD_MAGNET_URL, filename: env.LEAD_MAGNET_FILENAME },
    tokenFormat: { prefix: env.ATTRIBUTION_TOKEN_PREFIX, length: env.NANOID_LEN },
    log: botLogger,
  });

  // Фоновая обработка: webhook ACK'ает сразу, handleUpdate + processed_at — здесь (§28.12)
  const pipeline = new UpdatePipeline(
    async (update: Update, rowId: string) => {
      await bot.handleUpdate(update);
      await markUpdateProcessed(executor, rowId);
    },
    botLogger,
  );

  const sender = new OutboxSender(
    { executor, transport, log: botLogger },
    { perChatIntervalMs: 1000, batchSize: 10 },
  );

  const app = await buildServer({
    checks: {
      db: dbCheck,
      queue: () => queueCheck(env.REDIS_URL),
    },
    logger: { level: 'info' },
    routes: (appInstance) => {
      registerWebhookRoute(appInstance, {
        executor,
        secret: env.TELEGRAM_WEBHOOK_SECRET,
        pipeline,
      });
    },
  });

  // AN-10: в prod наружу только 443 через Caddy; bot:4100 — внутренняя сеть.
  await app.listen({ port: env.BOT_PORT, host: '0.0.0.0' });
  sender.start(250);
  app.log.info({ bot: env.TELEGRAM_BOT_USERNAME }, 'bot service started');

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'graceful shutdown');
    sender.stop();
    // ждём завершения in-flight update (bounded), затем закрываемся
    await Promise.race([pipeline.idle(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    await app.close();
    await appRedis.quit().catch(() => undefined);
    await prisma.$disconnect();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
}

void main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
