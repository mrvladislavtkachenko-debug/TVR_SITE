import {
  cancelActiveFlowRuns,
  claimDueOutbox,
  failOutbox,
  markOutboxSent,
  markUserBlocked,
  retryOutboxAt,
  setLifecycleState,
  skipAllOutboxForUser,
  type OutboxRow,
  type SqlExecutor,
} from '@tas/db/services';
import { emitBotEvents } from './emit.js';
import type { TelegramTransport, TgButton } from './telegram.js';
import { TelegramApiError } from './telegram.js';
import type { BotLogger } from './pipeline.js';

/**
 * Отправитель outbox (M5): БЕЗ BullMQ — прямой цикл опроса due-строк.
 * Контракт M5: пейсинг 1 сообщение/сек на чат; глобальные лимиты 25/s и
 * частотные cap'ы — M6 (§13.2/FR-6). Обработка 403 (§28.5) и 429 (§28.15).
 */

export interface SenderDeps {
  executor: SqlExecutor;
  transport: TelegramTransport;
  log: BotLogger;
}

export interface SenderOpts {
  perChatIntervalMs?: number;
  batchSize?: number;
}

export class OutboxSender {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly lastSentAt = new Map<string, number>(); // chatId → epoch ms
  private globalNotBefore = 0; // 429: пауза всего отправителя
  private readonly attempts = new Map<string, number>(); // outboxId → попытки
  private readonly perChatIntervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly deps: SenderDeps,
    opts: SenderOpts = {},
  ) {
    this.perChatIntervalMs = opts.perChatIntervalMs ?? 1000;
    this.batchSize = opts.batchSize ?? 10;
  }

  start(tickMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickSafely();
    }, tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tickSafely(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err: unknown) {
      this.deps.log.error({ err: String(err).slice(0, 300) }, 'sender tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Один проход: захват due-строк → отправка с учётом пейсинга. */
  async tick(): Promise<{ claimed: number; sent: number; deferred: number }> {
    if (Date.now() < this.globalNotBefore) return { claimed: 0, sent: 0, deferred: 0 };
    const claimedList = await claimDueOutbox(this.deps.executor, this.batchSize);
    let sent = 0;
    let deferred = 0;
    const seenChats = new Set<string>();
    const blockedUsers = new Set<string>(); // §28.5: после 403 не трогаем строки юзера
    const rows = [...claimedList].sort((a, b) => Number(a.id) - Number(b.id));
    for (const row of rows) {
      if (blockedUsers.has(row.user_id)) continue; // уже погашены каскадом
      const chatId = row.payload.chat_id;
      if (typeof chatId !== 'string' || chatId === '') {
        await failOutbox(this.deps.executor, row.id, 'payload without chat_id');
        continue;
      }
      // ≤1 сообщение на чат за проход; прочие — отложить (1/s на чат)
      const last = this.lastSentAt.get(chatId) ?? 0;
      const earliest = Math.max(last + this.perChatIntervalMs, Date.now());
      if (seenChats.has(chatId) || Date.now() < last + this.perChatIntervalMs) {
        await retryOutboxAt(
          this.deps.executor,
          row.id,
          'paced: 1 msg/s per chat',
          new Date(earliest),
        );
        deferred += 1;
        continue;
      }
      seenChats.add(chatId);
      const outcome = await this.sendRow(row, chatId);
      if (outcome === 'sent') sent += 1;
      if (outcome === 'blocked') blockedUsers.add(row.user_id);
    }
    return { claimed: rows.length, sent, deferred };
  }

  private async sendRow(
    row: OutboxRow,
    chatId: string,
  ): Promise<'sent' | 'blocked' | 'failed'> {
    try {
      let messageId: string;
      const doc = row.payload.document as
        | { url: string; filename: string; caption?: string }
        | undefined;
      if (doc && typeof doc.url === 'string') {
        messageId = await this.deps.transport.sendDocument(
          chatId,
          doc.url,
          doc.filename,
          doc.caption,
        );
      } else {
        messageId = await this.deps.transport.sendMessage(
          chatId,
          String(row.payload.text ?? ''),
          row.payload.buttons as TgButton[] | undefined,
        );
      }
      this.lastSentAt.set(chatId, Date.now());
      await markOutboxSent(this.deps.executor, row.id, messageId);
      this.attempts.delete(row.id);
      if (row.payload.delivery_kind === 'file' || row.payload.delivery_kind === 'link') {
        // §16.2: событие на фактическую отправку лид-магнита
        await emitBotEvents(
          { executor: this.deps.executor },
          [
            {
              name: 'lead_magnet_delivered',
              userId: row.user_id,
              properties: { delivery_kind: row.payload.delivery_kind },
            },
          ],
          `outbox:${row.id}`,
        );
      }
      return 'sent';
    } catch (err: unknown) {
      const outcome = await this.handleSendError(row, chatId, err);
      return outcome;
    }
  }

  private async handleSendError(
    row: OutboxRow,
    chatId: string,
    err: unknown,
  ): Promise<'blocked' | 'failed'> {
    if (err instanceof TelegramApiError) {
      if (err.code === 403) {
        await this.handleBlocked(row, chatId);
        return 'blocked';
      }
      if (err.code === 429) {
        // §28.15: retry_after → пауза отправителя + отсрочка строки
        const retryAfter = err.retryAfterSeconds ?? 5;
        this.globalNotBefore = Date.now() + (retryAfter + 0.5) * 1000;
        await retryOutboxAt(
          this.deps.executor,
          row.id,
          `429: retry after ${retryAfter}s`,
          new Date(Date.now() + (retryAfter + 1) * 1000),
        );
        this.deps.log.warn({ outbox_id: row.id, retry_after: retryAfter }, 'telegram 429');
        return 'failed';
      }
      if (err.code >= 500) {
        await this.retryOrFail(row, `telegram 5xx: ${err.description}`);
        return 'failed';
      }
      // прочие 4xx — терминальные (например, недействительный chat и т.п.)
      await failOutbox(this.deps.executor, row.id, `telegram ${err.code}: ${err.description}`);
      return 'failed';
    }
    // сеть/таймаут — ретраи с отсрочкой
    await this.retryOrFail(row, `network: ${String(err).slice(0, 200)}`);
    return 'failed';
  }

  private async retryOrFail(row: OutboxRow, error: string): Promise<void> {
    const attempts = (this.attempts.get(row.id) ?? 0) + 1;
    this.attempts.set(row.id, attempts);
    if (attempts >= 3) {
      this.attempts.delete(row.id);
      await failOutbox(this.deps.executor, row.id, `${error} (attempts exhausted)`);
      return;
    }
    await retryOutboxAt(this.deps.executor, row.id, error, new Date(Date.now() + 5000));
  }

  /** §28.5: 403 при отправке — блокировка пользователя, каскадная отмена ВСЕГО outbox. */
  private async handleBlocked(row: OutboxRow, chatId: string): Promise<void> {
    const { executor, log } = this.deps;
    const userId = row.user_id;
    await markUserBlocked(executor, userId);
    const prevLifecycle = await setLifecycleState(executor, userId, 'blocked');
    const runs = await cancelActiveFlowRuns(executor, userId);
    const skipped = await skipAllOutboxForUser(executor, userId);
    await failOutbox(executor, row.id, '403: bot blocked by user');
    await emitBotEvents(
      { executor },
      [
        { name: 'bot_blocked', userId, properties: { last_flow_code: null } },
        ...(prevLifecycle
          ? [{ name: 'user_state_changed' as const, userId, properties: { from: prevLifecycle, to: 'blocked' } }]
          : []),
      ],
      `outbox:${row.id}`,
    );
    log.warn({ user_id: userId, chat_id: chatId, cancelled_runs: runs, skipped_outbox: skipped }, 'user blocked the bot (403)');
  }
}
