import type { SqlExecutor } from '@tas/db/services';
import { addSegmentMembership, emitSafeBotEvent, removeSegmentMembership } from '@tas/db/services';
import type { EngineLogger } from './flowEngine.js';

/**
 * Cron-задачи воркера (§11.5, §15.4, §12.2): TTL telegram_updates (7d),
 * часовой пересчёт lifecycle (мгновенные — event-poller), часовой пересчёт
 * динамических сегментов rule_json.
 */

// --------------------------------------------------------------- TTL 7 дней
export async function ttlTelegramUpdates(executor: SqlExecutor): Promise<number> {
  const result = await executor.query(
    `WITH del AS (
       DELETE FROM telegram_updates WHERE received_at < now() - interval '7 days' RETURNING 1
     ) SELECT count(*)::int AS n FROM del`,
    [],
  );
  return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
}

// ----------------------------------------------------------- lifecycle (час)
export interface LifecycleTransition {
  user_id: string;
  from: string;
  to: string;
}

/**
 * Один переход как CTE: UPDATE ... WHERE lifecycle=X AND условие RETURNING
 * прошлого состояния (из prev-CTE). Возвращает пары для событий.
 */
async function transition(
  executor: SqlExecutor,
  to: string,
  where: string,
  params: unknown[] = [],
): Promise<LifecycleTransition[]> {
  const result = await executor.query(
    `WITH prev AS (
       SELECT p.user_id, p.lifecycle_state FROM user_profiles p
       JOIN users u ON u.id = p.user_id
       WHERE p.lifecycle_state <> $1 AND ${where}
       FOR UPDATE OF p
     )
     UPDATE user_profiles p SET lifecycle_state = $1
     FROM prev WHERE p.user_id = prev.user_id AND p.lifecycle_state = prev.lifecycle_state
     RETURNING prev.user_id AS user_id, prev.lifecycle_state AS from`,
    [to, ...params],
  );
  return (result.rows as { user_id: string | bigint; from: string }[]).map((r) => ({
    user_id: String(r.user_id),
    from: r.from,
    to,
  }));
}

export interface LifecycleRecalcResult {
  transitions: LifecycleTransition[];
  activated: string[]; // user_id с первой активацией (для activated_at)
}

/** Часовой пересчёт (§11.5; мгновенные переходы делает event-poller). */
export async function recalcLifecycle(
  executor: SqlExecutor,
  log: EngineLogger,
): Promise<LifecycleRecalcResult> {
  const transitions: LifecycleTransition[] = [];

  // onboarded → activated: ≥2 content_viewed или ≥1 button_clicked за 7d
  transitions.push(
    ...(await transition(
      executor,
      'activated',
      `p.lifecycle_state = 'onboarded' AND (
         SELECT count(*) FROM events e WHERE e.user_id = p.user_id
           AND e.name IN ('content_viewed') AND e.occurred_at > now() - interval '7 days'
       ) >= 2 OR (
         SELECT count(*) FROM events e WHERE e.user_id = p.user_id
           AND e.name = 'button_clicked' AND e.occurred_at > now() - interval '7 days'
       ) >= 1`,
    )),
  );

  // new → churned: 7 дней без завершения онбординга (§11.5)
  transitions.push(
    ...(await transition(
      executor,
      'churned',
      `p.lifecycle_state = 'new' AND p.onboarding_completed_at IS NULL
         AND u.first_seen_at < now() - interval '7 days'`,
    )),
  );

  // activated/engaged → at_risk: 14 дней без активности
  transitions.push(
    ...(await transition(
      executor,
      'at_risk',
      `p.lifecycle_state IN ('activated','engaged')
         AND u.last_activity_at < now() - interval '14 days'`,
    )),
  );

  // at_risk → churned: 30 дней без активности
  transitions.push(
    ...(await transition(
      executor,
      'churned',
      `p.lifecycle_state = 'at_risk' AND u.last_activity_at < now() - interval '30 days'`,
    )),
  );

  // at_risk → engaged: активность вернулась (§11.5)
  transitions.push(
    ...(await transition(
      executor,
      'engaged',
      `p.lifecycle_state = 'at_risk' AND u.last_activity_at > now() - interval '14 days'`,
    )),
  );

  // activated → engaged: ≥3 активностей за 7d
  transitions.push(
    ...(await transition(
      executor,
      'engaged',
      `p.lifecycle_state = 'activated' AND (
         SELECT count(*) FROM events e WHERE e.user_id = p.user_id
           AND e.name IN ('content_viewed','button_clicked','message_received')
           AND e.occurred_at > now() - interval '7 days'
       ) >= 3`,
    )),
  );

  // события переходов + user_activated (§16.2)
  const activated: string[] = [];
  for (const t of transitions) {
    await emitSafeBotEvent(executor, {
      name: 'user_state_changed',
      userId: t.user_id,
      properties: { from: t.from, to: t.to },
      dedupKey: `cron:${Math.floor(Date.now() / 1000)}:${t.user_id}:${t.from}:${t.to}`,
    });
    if (t.to === 'activated') {
      activated.push(t.user_id);
      const days = await executor.query(
        `SELECT EXTRACT(DAY FROM now() - first_seen_at)::int AS d FROM users WHERE id = $1`,
        [t.user_id],
      );
      await executor.execute(
        `UPDATE user_profiles SET activated_at = now() WHERE user_id = $1 AND activated_at IS NULL`,
        [t.user_id],
      );
      await emitSafeBotEvent(executor, {
        name: 'user_activated',
        userId: t.user_id,
        properties: { days_since_start: Number((days.rows[0] as { d: number } | undefined)?.d ?? 0) },
        dedupKey: `cron:${Math.floor(Date.now() / 1000)}:${t.user_id}:user_activated`,
      });
    }
  }
  log.info({ transitions: transitions.length }, 'lifecycle recalc');
  return { transitions, activated };
}

// ------------------------------------------------- динамические сегменты (час)
export interface SegmentRule {
  event: string;
  op: 'gte' | 'lte';
  count: number;
  within_hours: number;
}

export function parseSegmentRule(raw: unknown): { match: 'all' | 'any'; rules: SegmentRule[] } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as { match?: unknown; rules?: unknown };
  if (!Array.isArray(obj.rules)) return null;
  const rules: SegmentRule[] = [];
  for (const r of obj.rules as unknown[]) {
    if (typeof r !== 'object' || r === null) return null;
    const rr = r as { event?: unknown; op?: unknown; count?: unknown; within_hours?: unknown };
    if (typeof rr.event !== 'string' || (rr.op !== 'gte' && rr.op !== 'lte')) return null;
    if (typeof rr.count !== 'number' || typeof rr.within_hours !== 'number') return null;
    rules.push({ event: rr.event, op: rr.op, count: rr.count, within_hours: rr.within_hours });
  }
  const match = obj.match === 'any' ? 'any' : 'all';
  return { match, rules };
}

async function userMatchesRule(
  executor: SqlExecutor,
  userId: string,
  rule: SegmentRule,
): Promise<boolean> {
  const result = await executor.query(
    `SELECT count(*)::int AS n FROM events
     WHERE user_id = $1 AND name = $2 AND occurred_at > now() - make_interval(hours => $3)`,
    [userId, rule.event, rule.within_hours],
  );
  const n = Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
  return rule.op === 'gte' ? n >= rule.count : n <= rule.count;
}

/**
 * Пересчёт динамических сегментов (§12.2): candidates = пользователи с
 * событиями за максимальное окно правил; членство origin='rule' добавляется/
 * снимается. seed: intent_high (checkout без покупки 48h), cold (0 просмотров 7d).
 */
export async function recalcDynamicSegments(
  executor: SqlExecutor,
  log: EngineLogger,
  maxUsers = 5000,
): Promise<{ segment: string; added: number; removed: number }[]> {
  const segments = await executor.query(
    `SELECT s.id, s.code, s.rule_json, COALESCE(
       (SELECT max((r->>'within_hours')::int) FROM jsonb_array_elements(s.rule_json->'rules') r
     ), 168) AS max_hours
     FROM segments s WHERE s.kind = 'dynamic' AND s.rule_json IS NOT NULL`,
    [],
  );
  const report: { segment: string; added: number; removed: number }[] = [];
  for (const seg of segments.rows as { id: string | bigint; code: string; rule_json: unknown; max_hours: number }[]) {
    const rule = parseSegmentRule(seg.rule_json);
    if (!rule || rule.rules.length === 0) {
      log.warn({ segment: seg.code }, 'dynamic segment: invalid rule_json');
      continue;
    }
    const candidates = await executor.query(
      `SELECT DISTINCT e.user_id FROM events e
       JOIN users u ON u.id = e.user_id
       WHERE e.name = ANY($1::text[]) AND e.occurred_at > now() - make_interval(hours => $2)
       LIMIT $3`,
      [rule.rules.map((r) => r.event), seg.max_hours, maxUsers],
    );
    let added = 0;
    let removed = 0;
    for (const row of candidates.rows as { user_id: string | bigint }[]) {
      const userId = String(row.user_id);
      const results = await Promise.all(
        rule.rules.map((r) => userMatchesRule(executor, userId, r)),
      );
      const matches = rule.match === 'all' ? results.every(Boolean) : results.some(Boolean);
      if (matches) {
        const before = await executor.query(
          `SELECT 1 FROM user_segments WHERE user_id = $1 AND segment_id = $2 AND removed_at IS NULL`,
          [userId, String(seg.id)],
        );
        await addSegmentMembership(executor, { userId, segmentId: String(seg.id), origin: 'rule' });
        if (before.rows.length === 0) {
          added += 1;
          await emitSafeBotEvent(executor, {
            name: 'segment_assigned',
            userId,
            properties: { segment_code: seg.code, origin: 'rule' },
            dedupKey: `cronseg:${Math.floor(Date.now() / 60000)}:${userId}:${seg.code}`,
          });
        }
      } else {
        const removedCount = await executor.query(
          `WITH rm AS (
             UPDATE user_segments SET removed_at = now()
             WHERE user_id = $1 AND segment_id = $2 AND removed_at IS NULL AND origin = 'rule'
             RETURNING 1
           ) SELECT count(*)::int AS n FROM rm`,
          [userId, String(seg.id)],
        );
        removed += Number((removedCount.rows[0] as { n: number } | undefined)?.n ?? 0);
      }
    }
    report.push({ segment: seg.code, added, removed });
  }
  return report;
}

export { removeSegmentMembership };
