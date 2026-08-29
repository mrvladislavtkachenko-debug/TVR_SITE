import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { createFlowScheduler } from '../src/flowWorker.js';
import { rehydrateActiveRuns, type EngineDeps } from '../src/flowEngine.js';
import { WorkerFakeDb } from './helpers/workerFakeDb.js';
import { MemoryLogger } from '../../bot/test/helpers/harness.js';

/**
 * «Пережил рестарт worker» (контракт M6) — НАСТОЯЩИЙ Redis + BullMQ:
 * delayed-джобы живут в Redis, воркер-инстансы приходят и уходят.
 * Пропускается целиком, если локальный Redis недоступен (hermetic-окружения).
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
// top-level: describe.skipIf вычисляется при сборке (до beforeAll)
const redisOk = await pingRedis();

afterAll(async () => {
  if (!redisOk) return;
  const q = new Queue('tas-test-cleanup', { connection: { url: REDIS_URL } });
  await q.obliterate({ force: true }).catch(() => undefined);
  await q.close();
});

async function pingRedis(): Promise<boolean> {
  const { Redis } = await import('ioredis');
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 300,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    try {
      redis.disconnect();
    } catch {
      /* не подключён */
    }
  }
}

const connection = () => ({ url: REDIS_URL });

describe.skipIf(!redisOk)('BullMQ: рестарт воркера (реальный Redis)', () => {
  it('delayed-джоба пережила закрытие и повторный запуск воркера', async () => {
    const queue = new Queue('tas-test-restart', { connection: connection() });
    await queue.obliterate({ force: true });
    let processed = 0;

    // воркер №1 получает delayed-джобу (1.2s) и «умирает» до её срока
    const w1 = new Worker(
      'tas-test-restart',
      async () => {
        processed += 1;
      },
      { connection: connection() },
    );
    await w1.waitUntilReady();
    await queue.add('tick', { v: 1 }, { delay: 1200 });
    await w1.close(); // «рестарт»: джоба осталась в Redis (delayed)

    // воркер №2 поднимается и обрабатывает её по наступлению срока
    const w2 = new Worker(
      'tas-test-restart',
      async () => {
        processed += 1;
      },
      { connection: connection() },
    );
    await w2.waitUntilReady();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(processed).toBe(1); // ровно один раз (at-least-once + идемпотентность на уровне БД)
    await w2.close();
    await queue.close();
  }, 15_000);

  it('scheduler: jobId fr-{run}-{step} — перепланирование не дублирует джобу', async () => {
    const queue = new Queue('tas-test-flows', { connection: connection() });
    await queue.obliterate({ force: true });
    const scheduler = createFlowScheduler(queue);

    const fireAt = new Date(Date.now() + 30_000);
    await scheduler.scheduleStep('run-1', 2, fireAt);
    await scheduler.scheduleStep('run-1', 2, fireAt); // дубль (rehydrate-гонка)
    await scheduler.scheduleStep('run-1', 2, new Date(Date.now() + 31_000));

    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.delayed).toBe(1);

    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('rehydrateActiveRuns: активные прогоны → delayed-джобы в реальной очереди', async () => {
    const db = new WorkerFakeDb();
    const queue = new Queue('tas-test-flows2', { connection: connection() });
    await queue.obliterate({ force: true });
    const engine: EngineDeps = {
      executor: db.executor,
      templates: { get: async () => null },
      scheduler: createFlowScheduler(queue),
      log: new MemoryLogger(),
    };
    db.seedFlow('welcome_series_v1', { trigger: { type: 'manual' }, steps: [{ action: 'delay', hours: 1 }], guard: { cancel_if: [] } });
    await db.executor.query(
      `INSERT INTO flow_runs (flow_id, flow_version, user_id, status, current_step, context)
       VALUES ($1, $2, $3, 'active', 0, '{}'::jsonb) RETURNING id`,
      ['flow-welcome_series_v1-v1', 1, '1'],
    );
    const r1 = await rehydrateActiveRuns(engine);
    expect(r1.runs).toBe(1);
    expect(r1).toEqual({ runs: 1, scheduled: 1 });
    // next_fire_at нет → джоба готова немедленно: waiting (не delayed)
    const counts = await queue.getJobCounts('waiting', 'delayed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(1);
    // повторный rehydrate — jobId уже существует, дубли нет
    await rehydrateActiveRuns(engine);
    const counts2 = await queue.getJobCounts('waiting', 'delayed');
    expect((counts2.waiting ?? 0) + (counts2.delayed ?? 0)).toBe(1);

    await queue.obliterate({ force: true });
    await queue.close();
  });
});
