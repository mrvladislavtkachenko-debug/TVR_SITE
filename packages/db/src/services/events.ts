import { createHash } from 'node:crypto';
import type { SqlExecutor } from './sql.js';

/**
 * События (PRD §16, Э8): батч-инсерт с ON CONFLICT (dedup_key) DO NOTHING.
 * Строитель SQL вынесен в чистую функцию для тестов.
 */

export interface EventInsert {
  name: string;
  userId?: string | null;
  trackingLinkId?: string | null;
  occurredAt?: Date;
  properties?: Record<string, unknown>;
  dedupKey?: string | null;
}

export interface BuiltInsert {
  sql: string;
  params: unknown[];
}

/** Чистый строитель параметризованного батч-INSERT (Э8). */
export function buildEventsInsertSql(events: EventInsert[]): BuiltInsert {
  if (events.length === 0) throw new Error('buildEventsInsertSql: пустой батч');
  const values: string[] = [];
  const params: unknown[] = [];
  events.forEach((e, i) => {
    const b = i * 6;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::jsonb,$${b + 6})`);
    params.push(
      e.name,
      e.userId ?? null,
      e.trackingLinkId ?? null,
      e.occurredAt ?? new Date(),
      JSON.stringify(e.properties ?? {}),
      e.dedupKey ?? null,
    );
  });
  const sql =
    `INSERT INTO events (name, user_id, tracking_link_id, occurred_at, properties, dedup_key) VALUES ` +
    `${values.join(',')} ON CONFLICT (dedup_key) DO NOTHING`;
  return { sql, params };
}

/** Записать батч событий; возвращает число реально вставленных строк. */
export async function recordEvents(
  deps: { executor: SqlExecutor },
  events: EventInsert[],
): Promise<number> {
  const { sql, params } = buildEventsInsertSql(events);
  return deps.executor.execute(sql, params);
}

/** salted SHA-256 от IP (32 байта hex, 64 символа); сырой IP не хранится (§23). */
export function ipHash(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`, 'utf8').digest('hex');
}

/** Счётчик событий пользователя за окно (для conditions/guard §13.1). */
export async function countUserEvents(
  deps: { executor: SqlExecutor },
  input: { userId: string; name: string; hours: number },
): Promise<number> {
  const result = await deps.executor.query(
    `SELECT count(*)::int AS n FROM events
     WHERE user_id = $1 AND name = $2 AND occurred_at >= now() - make_interval(hours => $3)`,
    [input.userId, input.name, input.hours],
  );
  return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
}
