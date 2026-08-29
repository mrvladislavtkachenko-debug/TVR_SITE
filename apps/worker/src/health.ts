import http from 'node:http';
import type { EngineLogger } from './flowEngine.js';

/**
 * Метрики очередей (контракт M6): depth/processed/failed BullMQ-очередей —
 * JSON-лог раз в 30с + внутренний HTTP /health для будущих алертов (§21.3:
 * queue depth > 1000, 429-rate). Порт WORKER_PORT — только внутренняя сеть.
 */

export interface QueueCountSource {
  getJobCounts(...types: string[]): Promise<unknown>;
}

export interface QueueMetrics {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export async function collectQueueMetrics(
  name: string,
  queue: QueueCountSource,
): Promise<QueueMetrics> {
  const raw = (await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')) as
    | Record<string, number | undefined>
    | undefined;
  const counts = raw ?? {};
  return {
    queue: name,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };
}

export interface HealthState {
  queues(): Promise<QueueMetrics[]>;
  dbUp(): Promise<boolean>;
}

export function startHealthServer(state: HealthState, port: number, log: EngineLogger): { close(): void } {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      void (async () => {
        const queues = await Promise.all(
          (
            await state.queues()
          ).map((q) => Promise.resolve(q)),
        );
        const dbUp = await state.dbUp();
        const ok = dbUp;
        res.statusCode = ok ? 200 : 503;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down', queues }));
      })();
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(port, '0.0.0.0');
  log.info({ port }, 'worker health/metrics server');
  return { close: () => server.close() };
}

/** Периодический JSON-лог метрик (алерты — внешний мониторинг по /health). */
export function startMetricsLoop(
  state: HealthState,
  log: EngineLogger,
  intervalMs = 30_000,
): { close(): void } {
  const timer = setInterval(() => {
    void state
      .queues()
      .then((qs) => log.info({ queues: qs }, 'queue metrics'))
      .catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return { close: () => clearInterval(timer) };
}
