import type { SqlExecutor } from './sql.js';

/**
 * messages_outbox (§11.1: ВСЕ исходящие сообщения — только через outbox;
 * Э2: broadcast_id). M5: прямой отправитель с 1/s на чат; лимиты BullMQ — M6.
 */

export type OutboxKind = 'flow' | 'broadcast' | 'transactional';

export interface OutboxInsert {
  userId: string;
  kind: OutboxKind;
  templateCode?: string | null;
  /** Сериализуемый payload отправки: chat_id, text/buttons или document. */
  payload?: Record<string, unknown> | null;
  dedupKey?: string | null;
  scheduledAt?: Date;
}

export interface OutboxRow {
  id: string;
  user_id: string;
  kind: OutboxKind;
  template_code: string | null;
  payload: Record<string, unknown>;
}

/** Пакетная постановка в outbox; дедуп — ON CONFLICT (dedup_key) DO NOTHING. */
export async function enqueueOutbox(
  executor: SqlExecutor,
  rows: OutboxInsert[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((r, i) => {
    const b = i * 6;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4}::jsonb,$${b + 5},$${b + 6})`);
    params.push(
      r.userId,
      r.kind,
      r.templateCode ?? null,
      JSON.stringify(r.payload ?? {}),
      r.dedupKey ?? null,
      r.scheduledAt ?? new Date(),
    );
  });
  return executor.execute(
    `INSERT INTO messages_outbox (user_id, kind, template_code, payload, dedup_key, scheduled_at)
     VALUES ${values.join(',')} ON CONFLICT (dedup_key) DO NOTHING`,
    params,
  );
}

/**
 * Захватить due-строки под отправку (SKIP LOCKED — безопасно при нескольких
 * инстансах отправителя). Строки переходят pending → sending.
 */
export async function claimDueOutbox(
  executor: SqlExecutor,
  limit: number,
): Promise<OutboxRow[]> {
  const result = await executor.query(
    `UPDATE messages_outbox SET status = 'sending'
     WHERE id IN (
       SELECT id FROM messages_outbox
       WHERE status = 'pending' AND scheduled_at <= now()
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_id, kind, template_code, payload`,
    [limit],
  );
  return result.rows as unknown as OutboxRow[];
}

export async function markOutboxSent(
  executor: SqlExecutor,
  id: string,
  telegramMessageId: string,
): Promise<void> {
  await executor.execute(
    `UPDATE messages_outbox SET status = 'sent', sent_at = now(), telegram_message_id = $2 WHERE id = $1`,
    [id, telegramMessageId],
  );
}

/** Вернуть строку в pending с отсрочкой (429 retry_after / пейсинг 1/s на чат). */
export async function retryOutboxAt(
  executor: SqlExecutor,
  id: string,
  error: string,
  retryAt: Date,
): Promise<void> {
  await executor.execute(
    `UPDATE messages_outbox SET status = 'pending', error = $3, scheduled_at = $2 WHERE id = $1`,
    [id, retryAt, error.slice(0, 500)],
  );
}

/** Терминальная неудача (после исчерпания попыток / 4xx). */
export async function failOutbox(executor: SqlExecutor, id: string, error: string): Promise<void> {
  await executor.execute(
    `UPDATE messages_outbox SET status = 'failed', error = $2, sent_at = now() WHERE id = $1`,
    [id, error.slice(0, 500)],
  );
}

/**
 * Отменить неподписанные отправки пользователя (/stop, блокировка §28.5):
 * pending/sending строки kind flow|broadcast → skipped.
 */
export async function skipOutboxForUser(executor: SqlExecutor, userId: string): Promise<number> {
  return executor.execute(
    `UPDATE messages_outbox SET status = 'skipped', sent_at = now()
     WHERE user_id = $1 AND status IN ('pending','sending') AND kind IN ('flow','broadcast')`,
    [userId],
  );
}

/**
 * Блокировка (§28.5 «отмена всех flow_runs и outbox»): недоставляемо ВСЁ,
 * включая транзакционные ответы — пользователь заблокировал бота.
 */
export async function skipAllOutboxForUser(executor: SqlExecutor, userId: string): Promise<number> {
  return executor.execute(
    `UPDATE messages_outbox SET status = 'skipped', sent_at = now()
     WHERE user_id = $1 AND status IN ('pending','sending')`,
    [userId],
  );
}
