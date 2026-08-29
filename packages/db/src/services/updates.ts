import type { SqlExecutor } from './sql.js';

/**
 * telegram_updates (§11.1, §28.9/28.12): сырые update — сырьё для дебага и
 * replay; уникальность update_id = идемпотентность webhook (повторная доставка
 * Telegram пропускается). TTL 7 дней — cron в M6.
 */

export interface StoredUpdate {
  id: string;
  update_id: string;
}

/** INSERT ON CONFLICT (update_id) DO NOTHING: новый update или null (дубликат). */
export async function insertNewUpdate(
  executor: SqlExecutor,
  updateId: string,
  payload: unknown,
): Promise<StoredUpdate | null> {
  const result = await executor.query(
    `INSERT INTO telegram_updates (update_id, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (update_id) DO NOTHING RETURNING id, update_id`,
    [updateId, JSON.stringify(payload)],
  );
  const row = result.rows[0] as { id: string | bigint; update_id: string | bigint } | undefined;
  return row ? { id: String(row.id), update_id: String(row.update_id) } : null;
}

/** Отметить обработанным (фон после успешного bot.handleUpdate). */
export async function markUpdateProcessed(executor: SqlExecutor, rowId: string): Promise<void> {
  await executor.execute('UPDATE telegram_updates SET processed_at = now() WHERE id = $1', [rowId]);
}
