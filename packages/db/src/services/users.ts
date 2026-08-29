import type { SqlExecutor } from './sql.js';

/**
 * Read-only сервис карточки пользователя (PRD §18 Users): атрибуция,
 * сегменты, последние события, заказы (заказы заполняются в M7).
 */

export interface UserCard {
  user: Record<string, unknown>;
  profile: Record<string, unknown> | null;
  segments: { code: string; added_at: string; removed_at: string | null }[];
  attribution: { touch: string; is_current: boolean; short_code: string; source_id: string; occurred_at: string }[];
  events: { name: string; occurred_at: string; properties: Record<string, unknown> }[];
}

export async function getUserCard(executor: SqlExecutor, userId: string): Promise<UserCard | null> {
  const user = await executor.query('SELECT * FROM users WHERE id = $1', [userId]);
  const userRow = user.rows[0] as Record<string, unknown> | undefined;
  if (!userRow) return null;

  // последовательно: одиночный pg-клиент не выполняет параллельные query
  // (Prisma-пул не ограничен, но код один для обоих исполнителей)
  const profile = await executor.query('SELECT * FROM user_profiles WHERE user_id = $1', [userId]);
  const segments = await executor.query(
    `SELECT s.code, us.added_at, us.removed_at FROM user_segments us
     JOIN segments s ON s.id = us.segment_id WHERE us.user_id = $1 ORDER BY us.added_at DESC`,
    [userId],
  );
  const attribution = await executor.query(
    `SELECT a.touch, a.is_current, tl.short_code, tl.source_id, a.occurred_at
     FROM attributions a JOIN tracking_links tl ON tl.id = a.tracking_link_id
     WHERE a.user_id = $1 ORDER BY a.occurred_at DESC`,
    [userId],
  );
  const events = await executor.query(
    'SELECT name, occurred_at, properties FROM events WHERE user_id = $1 ORDER BY id DESC LIMIT 100',
    [userId],
  );

  return {
    user: userRow,
    profile: (profile.rows[0] as Record<string, unknown>) ?? null,
    segments: segments.rows as UserCard['segments'],
    attribution: attribution.rows as UserCard['attribution'],
    events: events.rows as UserCard['events'],
  };
}

export async function listUsers(
  executor: SqlExecutor,
  opts: { q?: string; state?: string; limit?: number; offset?: number },
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    params.push(`%${opts.q}%`);
    conditions.push(`(username ILIKE $${params.length} OR CAST(telegram_id AS TEXT) LIKE $${params.length})`);
  }
  if (opts.state) {
    params.push(opts.state);
    conditions.push(
      `id IN (SELECT user_id FROM user_profiles WHERE lifecycle_state = $${params.length}::"LifecycleState")`,
    );
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = await executor.query(`SELECT COUNT(*)::int AS n FROM users ${where}`, params);
  params.push(Math.min(opts.limit ?? 50, 200));
  const limitIdx = params.length;
  params.push(opts.offset ?? 0);
  const rows = await executor.query(
    `SELECT u.*, p.lifecycle_state FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id
     ${where} ORDER BY u.id DESC LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
    params,
  );
  return { rows: rows.rows as Record<string, unknown>[], total: (total.rows[0] as { n: number }).n };
}
