import { describe, expect, it } from 'vitest';
import { SEED_FLOWS } from '../../../packages/db/seed/flowDefinitions.js';
import { pollOnce, applyInstantTransitions } from '../src/eventPoller.js';
import type { EngineDeps } from '../src/flowEngine.js';
import { WorkerFakeDb } from './helpers/workerFakeDb.js';
import { MemoryLogger } from '../../bot/test/helpers/harness.js';

/** Event-poller: watermark, диспетчеризация триггеров, мгновенные переходы. */

function makeEngine(db: WorkerFakeDb): EngineDeps {
  return {
    executor: db.executor,
    templates: { get: async (code) => db.templates.get(code) ?? null },
    scheduler: { scheduleStep: async () => undefined },
    log: new MemoryLogger(),
  };
}

async function seedUser(db: WorkerFakeDb, tgId: string, lifecycle = 'onboarded'): Promise<string> {
  await db.executor.query(
    `INSERT INTO users (telegram_id, username, first_name, locale, first_seen_at, last_activity_at)
     VALUES ($1,$2,$3,$4, now(), now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING id, (xmax = 0) AS inserted`,
    [tgId, 'u', 'Anna', 'en'],
  );
  const user = db.userByTelegram(tgId)!;
  db.profiles.set(user.id, {
    user_id: user.id,
    lifecycle_state: lifecycle,
    fsm_state: null,
    interest_segment_id: null,
    message_frequency: 'normal',
    onboarding_completed_at: new Date(),
  });
  return user.id;
}

function memWatermark() {
  let value: string | null = null;
  return {
    get: async () => value,
    set: async (id: string) => {
      value = id;
    },
  };
}

describe('pollOnce', () => {
  it('первый запуск: watermark = max(id), история не проигрывается', async () => {
    const db = new WorkerFakeDb();
    db.seedFlow(SEED_FLOWS[0]!.code, SEED_FLOWS[0]!.definition);
    const uid = await seedUser(db, '920');
    db.events.push({ name: 'onboarding_completed', user_id: uid, tracking_link_id: null, properties: { segment_code: 'S1' }, dedup_key: null });
    const watermark = memWatermark();
    const r = await pollOnce({ executor: db.executor, engine: makeEngine(db), log: new MemoryLogger(), watermark });
    expect(r.processed).toBe(0);
    expect(db.runs).toHaveLength(0); // событие ДО старта poller'а не триггерит
  });

  it('новое событие: welcome_series запускается; watermark двигается; повтор — не обрабатывается', async () => {
    const db = new WorkerFakeDb();
    for (const f of SEED_FLOWS) db.seedFlow(f.code, f.definition);
    const uid = await seedUser(db, '921');
    db.events.push({ name: 'onboarding_completed', user_id: uid, tracking_link_id: null, properties: { segment_code: 'S1' }, dedup_key: 'x1' });
    const watermark = memWatermark();
    const engine = makeEngine(db);
    const r0 = await pollOnce({ executor: db.executor, engine, log: new MemoryLogger(), watermark });
    expect(r0.processed).toBe(0); // инициализация

    db.events.push({ name: 'onboarding_completed', user_id: uid, tracking_link_id: null, properties: { segment_code: 'S1' }, dedup_key: 'x2' });
    const r1 = await pollOnce({ executor: db.executor, engine, log: new MemoryLogger(), watermark });
    expect(r1.processed).toBe(1);
    expect(r1.flowsStarted).toBe(1);
    expect(db.runs).toHaveLength(1);

    // «повторная доставка» не происходит: событий после watermark нет
    const r2 = await pollOnce({ executor: db.executor, engine, log: new MemoryLogger(), watermark });
    expect(r2.processed).toBe(0);
    expect(db.runs).toHaveLength(1);
  });
});

describe('applyInstantTransitions (§11.5 мгновенные)', () => {
  it('button_clicked: onboarded → activated + user_activated', async () => {
    const db = new WorkerFakeDb();
    const uid = await seedUser(db, '922', 'onboarded');
    const out = await applyInstantTransitions(
      db.executor,
      { id: 'e1', name: 'button_clicked', user_id: uid, properties: { button_code: 'b', screen: 's' } },
      new MemoryLogger(),
    );
    expect(out).toEqual(['onboarded→activated']);
    expect(db.profiles.get(uid)!.lifecycle_state).toBe('activated');
    expect(db.eventsByName('user_activated')).toHaveLength(1);
    expect(db.eventsByName('user_state_changed')[0]!.properties).toEqual({ from: 'onboarded', to: 'activated' });
  });

  it('content_viewed ×2 → activated; одиночный — нет', async () => {
    const db = new WorkerFakeDb();
    const uid = await seedUser(db, '923', 'onboarded');
    // polled-события уже записаны ботом в events (poller читает таблицу)
    db.events.push({ name: 'content_viewed', user_id: uid, tracking_link_id: null, properties: { content_code: 'c1' }, dedup_key: null });
    expect(await applyInstantTransitions(db.executor, { id: 'e2', name: 'content_viewed', user_id: uid, properties: { content_code: 'c1' } }, new MemoryLogger())).toEqual([]);
    db.events.push({ name: 'content_viewed', user_id: uid, tracking_link_id: null, properties: { content_code: 'c2' }, dedup_key: null });
    const out = await applyInstantTransitions(db.executor, { id: 'e3', name: 'content_viewed', user_id: uid, properties: { content_code: 'c2' } }, new MemoryLogger());
    expect(out).toEqual(['onboarded→activated']);
  });

  it('activated пользователь не активируется повторно', async () => {
    const db = new WorkerFakeDb();
    const uid = await seedUser(db, '924', 'activated');
    const out = await applyInstantTransitions(db.executor, { id: 'e4', name: 'button_clicked', user_id: uid, properties: { button_code: 'b', screen: 's' } }, new MemoryLogger());
    expect(out).toEqual([]);
  });
});
