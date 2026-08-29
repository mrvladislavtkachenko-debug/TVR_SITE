import type { Update } from 'grammy/types';

/**
 * Фоновый конвейер обработки update (§11.1, §28.12): webhook ACK'ает сразу
 * после записи в telegram_updates, обработка идёт здесь с ограничением
 * конкурентности (§22: сглаживание бёрстов /start; полный rate-limit — M6).
 */

export interface BotLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export type UpdateHandler = (update: Update, rowId: string) => Promise<void>;

export class UpdatePipeline {
  private queue: { update: Update; rowId: string }[] = [];
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly handler: UpdateHandler,
    private readonly log: BotLogger,
    private readonly concurrency = 5,
  ) {}

  /** Постановка без ожидания: ответ webhook не ждёт обработки. */
  submit(update: Update, rowId: string): void {
    this.queue.push({ update, rowId });
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.active += 1;
      this.handler(item.update, item.rowId)
        .catch((err: unknown) => {
          // Ошибка обработки не рушит процесс: update остаётся с
          // processed_at IS NULL в telegram_updates (кандидат на replay, M6)
          this.log.error({ update_id: item.update.update_id }, 'update processing failed');
          if (err instanceof Error) this.log.error({ err: err.message }, 'processing error detail');
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
          if (this.active === 0 && this.queue.length === 0) {
            const waiters = this.waiters;
            this.waiters = [];
            for (const w of waiters) w();
          }
        });
    }
  }

  /** Дождаться завершения всех начатых и поставленных update (тесты, shutdown). */
  async idle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  get pending(): number {
    return this.queue.length + this.active;
  }
}
