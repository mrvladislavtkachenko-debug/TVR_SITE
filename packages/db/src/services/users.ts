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

// ---------------------------------------------------------------------------
// M5: бот — пользователи, FSM, lifecycle, сегменты (§11, §28)
// ---------------------------------------------------------------------------

export interface TelegramUserUpsertInput {
  telegramId: string;
  username?: string | null;
  firstName?: string | null;
  locale?: string | null;
}

/**
 * Upsert по telegram_id (§28.1/28.4): username/first_name/locale/last_activity
 * обновляются из каждого update; is_blocked НЕ трогается (разблокировка —
 * отдельный явный unblockUserIfBlocked). `inserted` — через xmax=0.
 */
export async function upsertTelegramUser(
  executor: SqlExecutor,
  input: TelegramUserUpsertInput,
): Promise<{ id: string; inserted: boolean }> {
  const result = await executor.query(
    `INSERT INTO users (telegram_id, username, first_name, locale, first_seen_at, last_activity_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       locale = EXCLUDED.locale,
       last_activity_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [input.telegramId, input.username ?? null, input.firstName ?? null, input.locale ?? null],
  );
  const row = result.rows[0] as { id: string | bigint; inserted: boolean };
  return { id: String(row.id), inserted: Boolean(row.inserted) };
}

/** Профиль 1:1 создаётся лениво при первом касании ботом. */
export async function ensureProfile(executor: SqlExecutor, userId: string): Promise<void> {
  await executor.execute(
    'INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
}

export interface BotUserState {
  lifecycle_state: string;
  fsm_state: { node: string; context?: Record<string, unknown> } | null;
  interest_segment_id: string | null;
  interest_segment_code: string | null;
  message_frequency: 'normal' | 'low';
  onboarding_completed_at: Date | string | null;
}

/** Снимок состояния пользователя для FSM-маршрутизации (§11.6). */
export async function getBotUserState(
  executor: SqlExecutor,
  userId: string,
): Promise<BotUserState | null> {
  const result = await executor.query(
    `SELECT p.lifecycle_state, p.fsm_state, p.interest_segment_id, s.code AS interest_segment_code,
            p.message_frequency, p.onboarding_completed_at
     FROM user_profiles p
     LEFT JOIN segments s ON s.id = p.interest_segment_id
     WHERE p.user_id = $1`,
    [userId],
  );
  const row = result.rows[0] as
    | {
        lifecycle_state: string;
        fsm_state: BotUserState['fsm_state'];
        interest_segment_id: string | bigint | null;
        interest_segment_code: string | null;
        message_frequency: 'normal' | 'low';
        onboarding_completed_at: Date | string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    lifecycle_state: row.lifecycle_state,
    fsm_state: row.fsm_state ?? null,
    interest_segment_id: row.interest_segment_id === null ? null : String(row.interest_segment_id),
    interest_segment_code: row.interest_segment_code,
    message_frequency: row.message_frequency,
    onboarding_completed_at: row.onboarding_completed_at,
  };
}

/** FSM в user_profiles.fsm_state (§11.6); null = idle. */
export async function setFsmState(
  executor: SqlExecutor,
  userId: string,
  state: { node: string; context?: Record<string, unknown> } | null,
): Promise<void> {
  await executor.execute(`UPDATE user_profiles SET fsm_state = $2::jsonb WHERE user_id = $1`, [
    userId,
    state === null ? null : JSON.stringify(state),
  ]);
}

export async function setMessageFrequency(
  executor: SqlExecutor,
  userId: string,
  frequency: 'normal' | 'low',
): Promise<void> {
  await executor.execute(
    `UPDATE user_profiles SET message_frequency = $2::"MessageFrequency" WHERE user_id = $1`,
    [userId, frequency],
  );
}

export async function getSegmentByCode(
  executor: SqlExecutor,
  code: string,
): Promise<{ id: string; code: string } | null> {
  const result = await executor.query(`SELECT id, code FROM segments WHERE code = $1`, [code]);
  const row = result.rows[0] as { id: string | bigint; code: string } | undefined;
  return row ? { id: String(row.id), code: row.code } : null;
}

/**
 * Выбрать сегмент интереса (§11.4) + членство в user_segments (origin=onboarding);
 * прежние onboarding-членства закрываются removed_at (история остаётся).
 */
export async function setInterestSegment(
  executor: SqlExecutor,
  userId: string,
  segmentId: string,
): Promise<void> {
  await executor.execute(`UPDATE user_profiles SET interest_segment_id = $2 WHERE user_id = $1`, [
    userId,
    segmentId,
  ]);
  await executor.execute(
    `UPDATE user_segments SET removed_at = now()
     WHERE user_id = $1 AND segment_id <> $2 AND removed_at IS NULL AND origin = 'onboarding'`,
    [userId, segmentId],
  );
  await executor.execute(
    `INSERT INTO user_segments (user_id, segment_id, origin) VALUES ($1, $2, 'onboarding')
     ON CONFLICT (user_id, segment_id) DO UPDATE SET removed_at = NULL, added_at = now()`,
    [userId, segmentId],
  );
}

/** Членство в произвольном сегменте (например, 'unsubscribed' при /stop). */
export async function addSegmentMembership(
  executor: SqlExecutor,
  input: { userId: string; segmentId: string; origin: 'onboarding' | 'rule' | 'manual' },
): Promise<void> {
  await executor.execute(
    `INSERT INTO user_segments (user_id, segment_id, origin) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, segment_id) DO UPDATE SET removed_at = NULL, added_at = now()`,
    [input.userId, input.segmentId, input.origin],
  );
}

/**
 * Завершить онбординг: onboarding_completed_at ставится РОВНО один раз.
 * Возвращает true, если это было первое завершение (эмиттер события решает по флагу).
 */
export async function completeOnboarding(executor: SqlExecutor, userId: string): Promise<boolean> {
  const result = await executor.execute(
    `UPDATE user_profiles SET onboarding_completed_at = now()
     WHERE user_id = $1 AND onboarding_completed_at IS NULL`,
    [userId],
  );
  return result > 0;
}

export type LifecycleState =
  | 'new'
  | 'onboarded'
  | 'activated'
  | 'engaged'
  | 'lead'
  | 'customer'
  | 'at_risk'
  | 'churned'
  | 'reactivated'
  | 'blocked';

/**
 * Lifecycle-переход (§11.5): меняет состояние только если оно отличается.
 * Возвращает ПРЕДЫДУЩЕЕ состояние (для события user_state_changed) или null,
 * если перехода не было.
 */
export async function setLifecycleState(
  executor: SqlExecutor,
  userId: string,
  to: LifecycleState,
): Promise<LifecycleState | null> {
  const result = await executor.query(
    `WITH prev AS (
       SELECT lifecycle_state FROM user_profiles WHERE user_id = $1 FOR UPDATE
     )
     UPDATE user_profiles SET lifecycle_state = $2::"LifecycleState"
     WHERE user_id = $1 AND lifecycle_state <> $2::"LifecycleState"
     RETURNING (SELECT lifecycle_state FROM prev) AS prev`,
    [userId, to],
  );
  const row = result.rows[0] as { prev: LifecycleState } | undefined;
  return row ? row.prev : null;
}

/**
 * Разблокировка (§28.5: «канал восстановления отсутствует — вернётся сам»):
 * любое входящее сообщение от заблокированного пользователя снимает флаг,
 * lifecycle → reactivated (§11.5). Возвращает прежний lifecycle для события
 * или null, если пользователь не был заблокирован.
 */
export async function unblockUserIfBlocked(
  executor: SqlExecutor,
  userId: string,
): Promise<LifecycleState | null> {
  const result = await executor.query(
    `UPDATE users SET is_blocked = false, blocked_at = NULL
     WHERE id = $1 AND is_blocked
     RETURNING (SELECT lifecycle_state FROM user_profiles WHERE user_id = $1) AS prev`,
    [userId],
  );
  const row = result.rows[0] as { prev: LifecycleState | null } | undefined;
  if (!row) return null;
  const prev = row.prev ?? 'blocked';
  await executor.execute(
    `UPDATE user_profiles SET lifecycle_state = 'reactivated'
     WHERE user_id = $1 AND lifecycle_state = 'blocked'`,
    [userId],
  );
  return prev;
}

/** Блокировка бота пользователем (403 при отправке, §28.5). */
export async function markUserBlocked(executor: SqlExecutor, userId: string): Promise<void> {
  await executor.execute(
    'UPDATE users SET is_blocked = true, blocked_at = now() WHERE id = $1',
    [userId],
  );
}

/** Закрыть членство в сегменте (resubscribe после /start). */
export async function removeSegmentMembership(
  executor: SqlExecutor,
  userId: string,
  segmentId: string,
): Promise<void> {
  await executor.execute(
    `UPDATE user_segments SET removed_at = now()
     WHERE user_id = $1 AND segment_id = $2 AND removed_at IS NULL`,
    [userId, segmentId],
  );
}
