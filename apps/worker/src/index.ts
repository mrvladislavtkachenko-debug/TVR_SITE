import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { workerEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { createPrisma } from '@tas/db/client';
import {
  createDbTemplateStore,
  prismaExecutor,
  resetStaleSending,
} from '@tas/db/services';
import { createHttpTransport } from './telegram.js';
import { createFlowScheduler } from './flowWorker.js';
import { processStep, rehydrateActiveRuns, type EngineDeps } from './flowEngine.js';
import { createEngineLogger } from './logger.js';
import {
  createScannerState,
  onOutboxJobFinallyFailed,
  processOutboxJob,
  scanOutbox,
  type OutboxWorkerDeps,
} from './outboxWorker.js';
import { pollOnce, EVENT_WATERMARK_KEY } from './eventPoller.js';
import {
  recalcDynamicSegments,
  recalcLifecycle,
  ttlTelegramUpdates,
} from './cron.js';
import { collectQueueMetrics, startHealthServer, startMetricsLoop } from './health.js';
import { startWorker, createShutdownSignal } from './runtime.js';

/**
 * apps/worker (M6): BullMQ-отправитель outbox + flow-движок + event-poller +
 * cron (TTL/lifecycle/сегменты) + health/metrics. Бот (apps/bot) с M6 —
 * webhook-only: пишет в БД, не отправляет сообщения.
 */

loadRootEnv();
const env = parseEnv(workerEnvSchema);
const prisma = createPrisma(env.DATABASE_URL);
const executor = prismaExecutor(prisma);
const log = createEngineLogger();

const connection: ConnectionOptions = { url: env.REDIS_URL };
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });

const OUTBOX_QUEUE = 'tas-outbox'; // NB: BullMQ запрещает ':' в имени очереди
const FLOW_QUEUE = 'tas-flows';

async function main(): Promise<void> {
  await redis.connect();

  // --- очередь отправки: глобальный лимит 25/s (§13.2; AN-26 про 1/s на чат)
  const outboxQueue = new Queue(OUTBOX_QUEUE, {
    connection,
    defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: false },
  });
  const flowQueue = new Queue(FLOW_QUEUE, { connection });

  const transport = createHttpTransport(env.TELEGRAM_BOT_TOKEN);
  const templates = createDbTemplateStore(executor);
  const scheduler = createFlowScheduler(flowQueue);
  const engine: EngineDeps = { executor, templates, scheduler, log };

  // --- BullMQ-воркеры
  const workerBox: { current: Worker | undefined } = { current: undefined };
  const outboxDeps: OutboxWorkerDeps = {
    executor,
    transport,
    log,
    queue: outboxQueue,
    workerRef: () => workerBox.current,
    dailyCap: env.DAILY_MSG_CAP_PER_USER,
  };

  const outboxWorker = new Worker(
    OUTBOX_QUEUE,
    async (job) => processOutboxJob(outboxDeps, job.data as { rowId: string }),
    {
      connection,
      limiter: { max: env.SENDER_RATE_PER_SEC, duration: 1000 },
      concurrency: 5,
    },
  );
  workerBox.current = outboxWorker;
  outboxWorker.on('failed', (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void onOutboxJobFinallyFailed(outboxDeps, job.data as { rowId: string } | undefined, err);
    }
  });

  const flowWorker = new Worker(
    FLOW_QUEUE,
    async (job) => {
      const data = job.data as { runId: string; step: number };
      const outcome = await processStep(engine, data.runId, data.step);
      log.info({ run_id: data.runId, step: data.step, outcome: outcome?.effect ?? 'skipped' }, 'flow step');
    },
    { connection, concurrency: 5 },
  );

  // --- rehydrate (контракт M6): застрявшие 'sending' → pending; активные
  // прогоны → перепланирование шага (delayed-джобы в Redis и так переживают
  // рестарт; jobId-идемпотентность исключает дубли)
  const restored = await resetStaleSending(executor);
  const rehydrated = await rehydrateActiveRuns(engine);
  log.info({ restored_sending: restored, ...rehydrated }, 'worker rehydrate');

  // --- сканер outbox (пейсинг 1/s на чат — при планировании)
  const scannerState = createScannerState();
  const scannerTimer = setInterval(() => {
    void scanOutbox(outboxDeps, scannerState).catch((err: unknown) => {
      log.error({ err: String(err).slice(0, 200) }, 'outbox scan failed');
    });
  }, 500);
  scannerTimer.unref?.();

  // --- event-poller: flow-триггеры + мгновенные lifecycle-переходы
  const watermark = {
    get: () => redis.get(EVENT_WATERMARK_KEY),
    set: (id: string) => redis.set(EVENT_WATERMARK_KEY, id).then(() => undefined),
  };
  const pollerTimer = setInterval(() => {
    void pollOnce({ executor, engine, log, watermark })
      .then((r) => {
        if (r.processed > 0) log.info({ ...r }, 'event poll');
      })
      .catch((err: unknown) => log.error({ err: String(err).slice(0, 200) }, 'event poll failed'));
  }, 1000);
  pollerTimer.unref?.();

  // --- cron: TTL 7d — раз в час; lifecycle + dynamic segments — раз в час
  const HOUR = 3600_000;
  const runCron = async (): Promise<void> => {
    try {
      const deleted = await ttlTelegramUpdates(executor);
      const lc = await recalcLifecycle(executor, log);
      const segs = await recalcDynamicSegments(executor, log);
      log.info({ ttl_deleted: deleted, lifecycle: lc.transitions.length, segments: segs }, 'cron hourly');
    } catch (err: unknown) {
      log.error({ err: String(err).slice(0, 300) }, 'cron failed');
    }
  };
  const cronTimer = setInterval(() => void runCron(), HOUR);
  cronTimer.unref?.();

  // --- health/metrics
  const healthState = {
    queues: () =>
      Promise.all([
        collectQueueMetrics(OUTBOX_QUEUE, outboxQueue),
        collectQueueMetrics(FLOW_QUEUE, flowQueue),
      ]),
    dbUp: async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
  };
  const healthServer = startHealthServer(healthState, env.WORKER_PORT, log);
  const metricsLoop = startMetricsLoop(healthState, log);

  log.info(
    { outbox: OUTBOX_QUEUE, flows: FLOW_QUEUE, rate: env.SENDER_RATE_PER_SEC, cap: env.DAILY_MSG_CAP_PER_USER },
    'worker started',
  );

  const signal = createShutdownSignal();
  const runtime = startWorker({
    signal,
    onShutdown: async () => {
      clearInterval(scannerTimer);
      clearInterval(pollerTimer);
      clearInterval(cronTimer);
      metricsLoop.close();
      healthServer.close();
      await outboxWorker.close();
      await flowWorker.close();
      await outboxQueue.close();
      await flowQueue.close();
      await redis.quit().catch(() => undefined);
      await prisma.$disconnect();
      log.info({}, 'worker stopped');
    },
  });
  await runtime.done;
}

void main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
