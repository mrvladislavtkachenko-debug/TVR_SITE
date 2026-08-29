import { describe, expect, it } from 'vitest';
import { parseSegmentRule, recalcDynamicSegments, recalcLifecycle, ttlTelegramUpdates } from '../src/cron.js';
import { WorkerFakeDb } from './helpers/workerFakeDb.js';
import { MemoryLogger } from '../../bot/test/helpers/harness.js';

/** Cron воркера: TTL telegram_updates, lifecycle-пересчёт, dynamic segments. */

function seedUser(db: WorkerFakeDb, tgId: string, over: { firstSeenDaysAgo?: number; lastActivityDaysAgo?: number; lifecycle?: string } = {}): string {
  // через ветку upsert, затем подправляем даты напрямую
  void db.executor.query(
    `INSERT INTO users (telegram_id, username, first_name, locale, first_seen_at, last_activity_at)
     VALUES ($1,$2,$3,$4, now(), now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING id, (xmax = 0) AS inserted`,
    [tgId, 'u', 'Anna', 'en'],
  );
  const user = db.userByTelegram(tgId)!;
  if (over.firstSeenDaysAgo !== undefined) {
    user.first_seen_at = new Date(Date.now() - over.firstSeenDaysAgo * 86400_000);
  }
  if (over.lastActivityDaysAgo !== undefined) {
    db.lastActivity.set(user.id, new Date(Date.now() - over.lastActivityDaysAgo * 86400_000));
  }
  db.profiles.set(user.id, {
    user_id: user.id,
    lifecycle_state: over.lifecycle ?? 'new',
    fsm_state: null,
    interest_segment_id: null,
    message_frequency: 'normal',
    onboarding_completed_at: over.lifecycle === undefined ? null : new Date(),
  });
  return user.id;
}

describe('ttlTelegramUpdates (7 дней)', () => {
  it('старше 7 дней удаляются, свежие остаются', async () => {
    const db = new WorkerFakeDb();
    await db.executor.execute(`INSERT INTO telegram_updates (update_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (update_id) DO NOTHING RETURNING id, update_id`, [9001, { __days_old: 9 }]);
    await db.executor.execute(`INSERT INTO telegram_updates (update_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (update_id) DO NOTHING RETURNING id, update_id`, [9002, { __days_old: 2 }]);
    const deleted = await ttlTelegramUpdates(db.executor);
    expect(deleted).toBe(1);
    expect(db.telegramUpdates.has('9002')).toBe(true);
    expect(db.telegramUpdates.has('9001')).toBe(false);
  });
});

describe('recalcLifecycle (§11.5, часовой)', () => {
  it('new → churned: 8 дней без онбординга', async () => {
    const db = new WorkerFakeDb();
    const uid = seedUser(db, '910', { firstSeenDaysAgo: 8 });
    const fresh = seedUser(db, '911', { firstSeenDaysAgo: 2 });
    const res = await recalcLifecycle(db.executor, new MemoryLogger());
    expect(db.profiles.get(uid)!.lifecycle_state).toBe('churned');
    expect(db.profiles.get(fresh)!.lifecycle_state).toBe('new');
    const changed = db.eventsByName('user_state_changed');
    expect(changed.some((e) => e.user_id === uid && e.properties.from === 'new' && e.properties.to === 'churned')).toBe(true);
    void res;
  });

  it('activated/engaged → at_risk: 15 дней тишины; at_risk → churned: 31 день', async () => {
    const db = new WorkerFakeDb();
    const risky = seedUser(db, '912', { lifecycle: 'engaged', lastActivityDaysAgo: 15 });
    const old = seedUser(db, '913', { lifecycle: 'at_risk', lastActivityDaysAgo: 31 });
    await recalcLifecycle(db.executor, new MemoryLogger());
    expect(db.profiles.get(risky)!.lifecycle_state).toBe('at_risk');
    expect(db.profiles.get(old)!.lifecycle_state).toBe('churned');
  });

  it('onboarded → activated: ≥2 content_viewed за 7d (+user_activated)', async () => {
    const db = new WorkerFakeDb();
    const uid = seedUser(db, '914', { lifecycle: 'onboarded' });
    db.events.push(ev(uid, 'content_viewed'), ev(uid, 'content_viewed'));
    await recalcLifecycle(db.executor, new MemoryLogger());
    expect(db.profiles.get(uid)!.lifecycle_state).toBe('activated');
    const activated = db.eventsByName('user_activated');
    expect(activated).toHaveLength(1);
    expect(activated[0]!.properties).toEqual({ days_since_start: 3 }); // фейк-константа
  });

  it('at_risk → engaged: активность вернулась (§11.5)', async () => {
    const db = new WorkerFakeDb();
    const uid = seedUser(db, '915', { lifecycle: 'at_risk', lastActivityDaysAgo: 1 });
    await recalcLifecycle(db.executor, new MemoryLogger());
    expect(db.profiles.get(uid)!.lifecycle_state).toBe('engaged');
  });
});

describe('recalcDynamicSegments (§12.2)', () => {
  it('intent_high: checkout без покупки → добавлен; с покупкой → нет', async () => {
    const db = new WorkerFakeDb();
    db.seedDynamicSegment('intent_high', {
      match: 'all',
      rules: [
        { event: 'checkout_opened', op: 'gte', count: 1, within_hours: 48 },
        { event: 'purchase_completed', op: 'lte', count: 0, within_hours: 48 },
      ],
    });
    const buyer = seedUser(db, '916');
    const abandoner = seedUser(db, '917');
    db.events.push(ev(buyer, 'checkout_opened'), ev(buyer, 'purchase_completed'), ev(abandoner, 'checkout_opened'));

    const report = await recalcDynamicSegments(db.executor, new MemoryLogger());
    expect(report).toContainEqual({ segment: 'intent_high', added: 1, removed: 0 });
    const seg = [...db.segments.values()].find((s) => s.code === 'intent_high')!;
    expect(db.userSegments.get(`${abandoner}:${seg.id}`)?.removed_at).toBeNull();
    expect(db.userSegments.get(`${buyer}:${seg.id}`)).toBeUndefined();
    // событие сегментации (origin rule)
    const segEvents = db.eventsByName('segment_assigned');
    expect(segEvents.some((e) => e.user_id === abandoner && e.properties.origin === 'rule')).toBe(true);
  });

  it('parseSegmentRule: валидный/мусор', () => {
    expect(
      parseSegmentRule({
        match: 'all',
        rules: [{ event: 'checkout_opened', op: 'gte', count: 1, within_hours: 48 }],
      }),
    ).toEqual({ match: 'all', rules: [{ event: 'checkout_opened', op: 'gte', count: 1, within_hours: 48 }] });
    expect(parseSegmentRule(null)).toBeNull();
    expect(parseSegmentRule({ rules: [{ event: 'x', op: 'regex', count: 1, within_hours: 1 }] })).toBeNull();
  });
});

function ev(userId: string, name: string) {
  return { name, user_id: userId, tracking_link_id: null, properties: {}, dedup_key: null };
}
