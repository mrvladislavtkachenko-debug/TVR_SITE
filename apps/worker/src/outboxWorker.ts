import type { Job, Worker } from 'bullmq';
import {
  claimDueOutbox,
  failOutbox,
  getOutboxRow,
  getOutboxStatus,
  lastSentAtForChat,
  retryOutboxAt,
} from '@tas/db/services';
import { sendOutboxRow } from './senderCore.js';
import type { WorkerLogger } from './senderCore.js';
import type { SqlExecutor } from '@tas/db/services';
import type { TelegramTransport } from './telegramTypes.js';

/**
 * Отправитель на BullMQ (M6, миграция из apps/bot):
 * - сканер: claimDueOutbox (FOR UPDATE SKIP LOCKED) → job `ob:{id}` с delay
 *   пейсинга 1/s на чат (AN-26: OSS BullMQ без groups — delay при планировании);
 * - очередь: limiter {max: SENDER_RATE_PER_SEC, duration: 1000} — глобальный cap;
 * - 429: retryOutboxAt + worker.rateLimit(retryAfter) — пауза отправителя;
 * - ретраи: BullMQ attempts=3 + backoff 5s; исчерпаны → failOutbox (событие failed).
 */

export interface OutboxWorkerDeps {
  executor: SqlExecutor;
  transport: TelegramTransport;
  log: WorkerLogger;
  /** BullMQ-очередь (tas:outbox) с настроенным limiter. */
  queue: { add(name: string, data: unknown, opts: Record<string, unknown>): Promise<Job<unknown> | void> };
  /** Текущий worker — для rateLimit(429-пауза). */
  workerRef(): Worker | undefined;
  dailyCap: number;
  perChatIntervalMs?: number;
}

export interface ScannerState {
  lastSentAt: Map<string, number>;
}

export function createScannerState(): ScannerState {
  return { lastSentAt: new Map() };
}

/** Один проход сканера: захват due-строк → постановка джоб с пейсингом. */
export async function scanOutbox(
  deps: OutboxWorkerDeps,
  state: ScannerState,
  now = Date.now(),
): Promise<{ claimed: number; scheduled: number; deferred: number }> {
  const intervalMs = deps.perChatIntervalMs ?? 1000;
  const rows = await claimDueOutbox(deps.executor, 20);
  let scheduled = 0;
  let deferred = 0;
  for (const row of rows) {
    const chatId = row.payload.chat_id;
    if (typeof chatId !== 'string' || chatId === '') {
      await failOutbox(deps.executor, row.id, 'payload without chat_id');
      continue;
    }
    // пейсинг 1/s на чат: in-memory + последний sent_at из БД (рестарт)
    let earliest = state.lastSentAt.get(chatId) ?? 0;
    if (earliest === 0) {
      const last = await lastSentAtForChat(deps.executor, chatId);
      if (last) earliest = last.getTime() + intervalMs;
    } else {
      earliest += intervalMs;
    }
    const delayMs = Math.max(0, earliest - now);
    if (delayMs > 0) deferred += 1;
    await deps.queue.add(
      'send',
      { rowId: row.id },
      {
        jobId: `ob-${row.id}`,
        delay: delayMs,
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: false,
      },
    );
    scheduled += 1;
    state.lastSentAt.set(chatId, Math.max(earliest, now));
  }
  return { claimed: rows.length, scheduled, deferred };
}

export interface OutboxJobData {
  rowId: string;
}

/** Процессор джобы отправки (вызывается BullMQ-воркером). */
export async function processOutboxJob(
  deps: OutboxWorkerDeps,
  data: OutboxJobData,
): Promise<'sent' | 'skipped' | 'blocked' | 'capped' | 'rescheduled'> {
  const status = await getOutboxStatus(deps.executor, data.rowId);
  if (status !== 'sending') return 'skipped'; // уже решена (повтор джобы/каскад)

  const row = await getOutboxRow(deps.executor, data.rowId);
  if (!row) return 'skipped';
  const chatId = row.payload.chat_id;
  if (typeof chatId !== 'string' || chatId === '') {
    await failOutbox(deps.executor, row.id, 'payload without chat_id');
    return 'skipped';
  }

  const outcome = await sendOutboxRow(
    { executor: deps.executor, transport: deps.transport, log: deps.log },
    row,
    chatId,
    { dailyCap: deps.dailyCap },
  );
  switch (outcome.kind) {
    case 'sent':
    case 'blocked':
    case 'capped':
      return outcome.kind;
    case 'failed':
      return 'skipped'; // строка уже failed в core
    case 'retryable': {
      const retryAt = outcome.retryAt ?? new Date(Date.now() + 5000);
      await retryOutboxAt(deps.executor, row.id, outcome.error, retryAt);
      if (outcome.error.startsWith('429')) {
        // §28.15: пауза отправителя на retry_after + ретрай этой джобы
        const retryAfter = Number(/(\d+)s/.exec(outcome.error)?.[1] ?? 5);
        const worker = deps.workerRef();
        if (worker) await worker.rateLimit((retryAfter + 0.5) * 1000);
      }
      throw new Error(outcome.error); // BullMQ повторит (attempts/backoff)
    }
  }
}

/** Слушатель final-fail: строка → failed (попытки BullMQ исчерпаны). */
export async function onOutboxJobFinallyFailed(
  deps: OutboxWorkerDeps,
  data: OutboxJobData | undefined,
  error: Error,
): Promise<void> {
  if (!data) return;
  await failOutbox(deps.executor, data.rowId, `attempts exhausted: ${String(error.message).slice(0, 300)}`);
  deps.log.error({ outbox_id: data.rowId }, 'outbox job failed (attempts exhausted)');
}
