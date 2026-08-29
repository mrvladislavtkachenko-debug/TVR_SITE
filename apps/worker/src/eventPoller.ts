import type { SqlExecutor } from '@tas/db/services';
import {
  countUserEvents,
  emitSafeBotEvent,
  getUserFacts,
  setLifecycleState,
  touchActivatedAt,
} from './pollerDeps.js';
import type { EngineDeps, EngineLogger } from './flowEngine.js';
import { onEvent } from './flowEngine.js';

/**
 * Event-poller (M6): бот/api пишут события в events; воркер опрашивает
 * новые строки (id > watermark), запускает flow-триггеры и МГНОВЕННЫЕ
 * lifecycle-переходы (§11.5 «события меняют мгновенно»; часовой пересчёт —
 * cron как страховка). Watermark — Redis (переживает рестарт воркера).
 */

export interface PolledEvent {
  id: string;
  name: string;
  user_id: string | null;
  properties: Record<string, unknown>;
}

export const EVENT_WATERMARK_KEY = 'tas:worker:evm';

export async function fetchEventsAfter(
  executor: SqlExecutor,
  afterId: string,
  limit = 200,
): Promise<PolledEvent[]> {
  const result = await executor.query(
    `SELECT id, name, user_id, properties FROM events WHERE id > $1 ORDER BY id LIMIT $2`,
    [afterId, limit],
  );
  return (result.rows as { id: string | bigint; name: string; user_id: string | bigint | null; properties: Record<string, unknown> }[]).map(
    (r) => ({
      id: String(r.id),
      name: r.name,
      user_id: r.user_id === null ? null : String(r.user_id),
      properties: r.properties,
    }),
  );
}

/** Мгновенные переходы по событию (чистая логика + executor-эффекты). */
export async function applyInstantTransitions(
  executor: SqlExecutor,
  event: PolledEvent,
  log: EngineLogger,
): Promise<string[]> {
  const transitions: string[] = [];
  if (!event.user_id) return transitions;

  // §11.5: onboarded → activated при ≥1 button_clicked или ≥2 content_viewed за 7d
  if (event.name === 'button_clicked' || event.name === 'content_viewed') {
    const likes = await getLifecycle(executor, event.user_id);
    if (likes !== 'onboarded') return transitions;
    let qualifies = false;
    if (event.name === 'button_clicked') {
      qualifies = true;
    } else {
      const views = await countUserEvents(
        { executor },
        { userId: event.user_id, name: 'content_viewed', hours: 24 * 7 },
      );
      qualifies = views >= 2;
    }
    if (qualifies) {
      const prev = await setLifecycleState(executor, event.user_id, 'activated');
      if (prev) {
        await touchActivatedAt(executor, event.user_id);
        const days = await daysSinceStart(executor, event.user_id);
        await emitSafeBotEvent(executor, {
          name: 'user_state_changed',
          userId: event.user_id,
          properties: { from: prev, to: 'activated' },
          dedupKey: `evm:${event.id}:user_state_changed`,
        });
        await emitSafeBotEvent(executor, {
          name: 'user_activated',
          userId: event.user_id,
          properties: { days_since_start: days },
          dedupKey: `evm:${event.id}:user_activated`,
        });
        transitions.push(`${prev}→activated`);
        log.info({ user_id: event.user_id, from: prev }, 'instant activation');
      }
    }
  }
  return transitions;
}

async function getLifecycle(executor: SqlExecutor, userId: string): Promise<string | null> {
  const facts = await getUserFacts(executor, userId);
  return facts?.lifecycle_state ?? null;
}

async function daysSinceStart(executor: SqlExecutor, userId: string): Promise<number> {
  const result = await executor.query(
    `SELECT EXTRACT(DAY FROM now() - first_seen_at)::int AS d FROM users WHERE id = $1`,
    [userId],
  );
  return Number((result.rows[0] as { d: number } | undefined)?.d ?? 0);
}

export interface EventPollerDeps {
  executor: SqlExecutor;
  engine: EngineDeps;
  log: EngineLogger;
  watermark: { get(): Promise<string | null>; set(id: string): Promise<void> };
}

export interface PollResult {
  processed: number;
  flowsStarted: number;
  instantTransitions: string[];
  stoppedAtId: string | null;
}

/** Один проход опроса: от watermark до конца (пачками). */
export async function pollOnce(deps: EventPollerDeps, maxBatches = 10): Promise<PollResult> {
  let afterId = (await deps.watermark.get()) ?? '';
  if (afterId === '') {
    // первый запуск: стартуем с текущего конца (историю не проигрываем)
    const result = await deps.executor.query(`SELECT COALESCE(MAX(id), 0)::text AS max FROM events`, []);
    afterId = String((result.rows[0] as { max: string }).max);
    await deps.watermark.set(afterId);
    return { processed: 0, flowsStarted: 0, instantTransitions: [], stoppedAtId: afterId };
  }

  let processed = 0;
  let flowsStarted = 0;
  const instantTransitions: string[] = [];
  let stoppedAtId: string | null = null;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const events = await fetchEventsAfter(deps.executor, afterId);
    if (events.length === 0) break;
    for (const event of events) {
      if (event.user_id) {
        const starts = await onEvent(deps.engine, {
          name: event.name as never,
          userId: event.user_id,
          properties: event.properties,
        });
        flowsStarted += starts.filter((s) => s.skipped === null).length;
      }
      instantTransitions.push(...(await applyInstantTransitions(deps.executor, event, deps.log)));
      afterId = event.id;
      processed += 1;
    }
    await deps.watermark.set(afterId);
    stoppedAtId = afterId;
    if (events.length < 200) break;
  }
  return { processed, flowsStarted, instantTransitions, stoppedAtId };
}
