import {
  cancelActiveFlowRuns,
  countSentToday,
  emitSafeBotEvent,
  failOutbox,
  markOutboxSent,
  markUserBlocked,
  retryOutboxAt,
  setLifecycleState,
  skipAllOutboxForUser,
  type OutboxRow,
  type SqlExecutor,
} from '@tas/db/services';
import type { TelegramTransport } from './telegramTypes.js';
import { TelegramApiError } from './telegram.js';

/**
 * Ядро отправителя outbox (мигрировано из apps/bot M5 → apps/worker M6).
 * Лимиты: глобальный 25/s — BullMQ limiter очереди; 1/s на чат — пейсинг
 * при планировании (queue.delay, AN-26); дневной cap — здесь (§13.2).
 * 403 → каскад блокировки §28.5; 429 → retryAfter наружу (воркер ставит
 * паузу через worker.rateLimit).
 */

export interface SenderCoreDeps {
  executor: SqlExecutor;
  transport: TelegramTransport;
  log: WorkerLogger;
}

export interface WorkerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export type SendOutcome =
  | { kind: 'sent'; messageId: string }
  | { kind: 'blocked' }
  | { kind: 'capped'; nextWindowAt: Date }
  | { kind: 'retryable'; error: string; retryAt?: Date }
  | { kind: 'failed'; error: string };

export function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Отправить одну строку outbox (уже захваченную 'sending'). */
export async function sendOutboxRow(
  deps: SenderCoreDeps,
  row: OutboxRow,
  chatId: string,
  opts: { dailyCap: number },
): Promise<SendOutcome> {
  const { executor } = deps;

  // Дневной cap автоматических сообщений (§13.2; транзакционные не считаются)
  if ((row.kind === 'flow' || row.kind === 'broadcast') && opts.dailyCap > 0) {
    const sentToday = await countSentToday(executor, row.user_id);
    if (sentToday >= opts.dailyCap) {
      const nextWindowAt = nextUtcMidnight();
      await retryOutboxAt(executor, row.id, `daily cap reached (${sentToday}/${opts.dailyCap})`, nextWindowAt);
      return { kind: 'capped', nextWindowAt };
    }
  }

  try {
    let messageId: string;
    const doc = row.payload.document as { url: string; filename: string; caption?: string } | undefined;
    if (doc && typeof doc.url === 'string') {
      messageId = await deps.transport.sendDocument(chatId, doc.url, doc.filename, doc.caption);
    } else {
      // шаблонные тексты flow-шагов рендерятся на постановке (payload.text)
      messageId = await deps.transport.sendMessage(
        chatId,
        String(row.payload.text ?? ''),
        row.payload.buttons as { text: string; callbackData: string }[] | undefined,
      );
    }
    await markOutboxSent(executor, row.id, messageId);
    if (row.payload.delivery_kind === 'file' || row.payload.delivery_kind === 'link') {
      await emitSafeBotEvent(executor, {
        name: 'lead_magnet_delivered',
        userId: row.user_id,
        properties: { delivery_kind: row.payload.delivery_kind },
        dedupKey: `outbox:${row.id}:lead_magnet_delivered`,
      });
    }
    return { kind: 'sent', messageId };
  } catch (err: unknown) {
    return handleSendError(deps, row, err);
  }
}

function handleSendError(deps: SenderCoreDeps, row: OutboxRow, err: unknown): SendOutcome {
  const { executor, log } = deps;
  if (err instanceof TelegramApiError) {
    if (err.code === 403) {
      void handleBlocked(deps, row).catch((e: unknown) => {
        log.error({ outbox_id: row.id, err: String(e).slice(0, 200) }, 'blocked-cascade failed');
      });
      return { kind: 'blocked' };
    }
    if (err.code === 429) {
      const retryAfter = err.retryAfterSeconds ?? 5;
      return {
        kind: 'retryable',
        error: `429: retry after ${retryAfter}s`,
        retryAt: new Date(Date.now() + (retryAfter + 1) * 1000),
      };
    }
    if (err.code >= 500) {
      return { kind: 'retryable', error: `telegram 5xx: ${err.description}` };
    }
    void failOutbox(executor, row.id, `telegram ${err.code}: ${err.description}`);
    return { kind: 'failed', error: `telegram ${err.code}` };
  }
  return { kind: 'retryable', error: `network: ${String(err).slice(0, 200)}` };
}

/** §28.5: 403 при отправке — блокировка пользователя, каскадная отмена ВСЕГО. */
async function handleBlocked(deps: SenderCoreDeps, row: OutboxRow): Promise<void> {
  const { executor, log } = deps;
  const userId = row.user_id;
  await markUserBlocked(executor, userId);
  const prevLifecycle = await setLifecycleState(executor, userId, 'blocked');
  const runs = await cancelActiveFlowRuns(executor, userId);
  const skipped = await skipAllOutboxForUser(executor, userId);
  await failOutbox(executor, row.id, '403: bot blocked by user');
  await emitSafeBotEvent(executor, {
    name: 'bot_blocked',
    userId,
    properties: { last_flow_code: null },
    dedupKey: `outbox:${row.id}:bot_blocked`,
  });
  if (prevLifecycle) {
    await emitSafeBotEvent(executor, {
      name: 'user_state_changed',
      userId,
      properties: { from: prevLifecycle, to: 'blocked' },
      dedupKey: `outbox:${row.id}:user_state_changed`,
    });
  }
  log.warn({ user_id: userId, cancelled_runs: runs, skipped_outbox: skipped }, 'user blocked the bot (403)');
}
