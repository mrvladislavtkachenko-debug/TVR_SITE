import type { StepScheduler } from './flowEngine.js';

/**
 * Планировщик шагов флоу поверх BullMQ: jobId `fr:{run}:{step}` —
 * идемпотентность перепланирования (rehydrate/гонки) на уровне очереди.
 * BullMQ хранит delayed-джобы в Redis (AOF) — рестарт воркера их не теряет.
 */
export interface FlowQueueLike {
  add(name: string, data: unknown, opts: Record<string, unknown>): Promise<unknown>;
}

export function createFlowScheduler(queue: FlowQueueLike): StepScheduler {
  return {
    async scheduleStep(runId, step, fireAt) {
      const delay = Math.max(0, fireAt.getTime() - Date.now());
      await queue.add(
        'step',
        { runId, step },
        {
          jobId: `fr-${runId}-${step}`,
          delay,
          attempts: 3,
          backoff: { type: 'fixed', delay: 10_000 },
          removeOnComplete: { age: 24 * 3600 },
          removeOnFail: false,
        },
      );
    },
  };
}
