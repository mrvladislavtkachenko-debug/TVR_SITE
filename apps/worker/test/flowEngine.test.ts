import { describe, expect, it } from 'vitest';
import { SEED_FLOWS } from '../../../packages/db/seed/flowDefinitions.js';
import {
  evalCondition,
  guardCancelReason,
  onEvent,
  parseEventExpr,
  parseFlowDefinition,
  processStep,
  rehydrateActiveRuns,
  triggerMatchesEvent,
  type EngineCtx,
  type EngineDeps,
} from '../src/flowEngine.js';
import type { TemplateStore, BotTemplate } from '@tas/db/services';
import { WorkerFakeDb } from './helpers/workerFakeDb.js';
import { MemoryLogger } from '../../bot/test/helpers/harness.js';

/**
 * Интерпретатор §13.1: таблица триггер→шаги→guard на СЕМЕННЫХ флоу
 * (welcome_series / checkout_abandonment / winback) + синтетические кейсы.
 */

function seedDef(code: string): Record<string, unknown> {
  const flow = SEED_FLOWS.find((f) => f.code === code);
  if (!flow) throw new Error(`seed flow ${code} не найден`);
  return flow.definition;
}

interface Harness {
  db: WorkerFakeDb;
  engine: EngineDeps;
  scheduled: { runId: string; step: number; fireAt: Date }[];
}

function makeEngine(templates: Record<string, BotTemplate> = {}): Harness {
  const db = new WorkerFakeDb();
  for (const flow of SEED_FLOWS) {
    db.seedFlow(flow.code, flow.definition);
  }
  db.templates.set('ws_value_1', { body: 'Совет №1', buttons: null });
  db.templates.set('ws_value_2', { body: 'Совет №2', buttons: null });
  db.templates.set('ws_offer_planner', { body: 'Planner Pack', buttons: null });
  db.templates.set('ca_objection_1', { body: 'Возражения', buttons: null });
  db.templates.set('ca_bonus_2', { body: 'Бонус', buttons: null });
  db.templates.set('wb_reengage', { body: 'Продолжим?', buttons: null });
  for (const [code, tpl] of Object.entries(templates)) db.templates.set(code, tpl);
  const scheduled: Harness['scheduled'] = [];
  const store: TemplateStore = { get: async (code) => db.templates.get(code) ?? null };
  const engine: EngineDeps = {
    executor: db.executor,
    templates: store,
    scheduler: {
      async scheduleStep(runId, step, fireAt) {
        if (!scheduled.some((s) => s.runId === runId && s.step === step)) {
          scheduled.push({ runId, step, fireAt });
        }
      },
    },
    log: new MemoryLogger(),
  };
  return { db, engine, scheduled };
}

async function withUser(h: Harness, tgId = '700'): Promise<string> {
  await h.db.executor.query(
    `INSERT INTO users (telegram_id, username, first_name, locale, first_seen_at, last_activity_at)
     VALUES ($1,$2,$3,$4, now(), now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, locale = EXCLUDED.locale, last_activity_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [tgId, 'anna', 'Anna', 'en'],
  );
  await h.db.executor.execute('INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [h.db.userByTelegram(tgId)!.id]);
  return h.db.userByTelegram(tgId)!.id;
}

describe('интерпретатор §13.1 — таблица триггер→шаги→guard', () => {
  it('welcome_series: onboarding_completed → 3 send_message (24/48/72h) + branch', async () => {
    const h = makeEngine();
    const userId = await withUser(h);
    const starts = await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S1' } });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.skipped).toBeNull();
    const run = h.db.runs[0]!;
    expect(run.status).toBe('active');

    // шаг 0: ws_value_1 (delay 24h принадлежит шагу 0 при старте)
    const step0 = await processStep(h.engine, run.id, 0);
    expect(step0?.effect).toContain('send_message(ws_value_1');
    const outboxRow = h.db.outbox.find((o) => o.template_code === 'ws_value_1');
    expect(outboxRow?.kind).toBe('flow');
    expect(outboxRow?.dedup_key).toBe(`${run.id}:0`); // §29.13 {flow_run}:{step}
    expect(h.scheduled.at(-1)).toMatchObject({ runId: run.id, step: 1 });
    const delta1 = h.scheduled.at(-1)!.fireAt.getTime() - Date.now();
    expect(delta1).toBeGreaterThan(47 * 3600_000); // delay_hours: 48 шага 1
    expect(delta1).toBeLessThan(49 * 3600_000);

    // шаг 1 → шаг 2 (72h), шаг 2 = оффер с stars_invoice-кнопкой (текстом, M7)
    await processStep(h.engine, run.id, 1);
    await processStep(h.engine, run.id, 2);
    expect(h.db.outbox.filter((o) => o.kind === 'flow')).toHaveLength(3);

    // шаг 3: branch — покупки не было → goto checkout_abandonment_v1
    const step3 = await processStep(h.engine, run.id, 3);
    expect(step3?.effect).toContain('branch→checkout_abandonment_v1');
    expect(h.db.runs.find((r) => r.id === run.id)?.status).toBe('completed');
    const abRun = h.db.runs.find((r) => r.id !== run.id && r.status === 'active');
    expect(abRun).toBeDefined(); // новый прогон запущен
  });

  it('welcome_series branch: покупка была → guard purchased_product гасит прогон ДО branch (§13.1)', async () => {
    const h = makeEngine();
    const userId = await withUser(h, '701');
    await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S2' } });
    const run = h.db.runs[0]!;
    await processStep(h.engine, run.id, 0);
    await processStep(h.engine, run.id, 1);
    await processStep(h.engine, run.id, 2);
    h.db.events.push({
      name: 'purchase_completed',
      user_id: userId,
      tracking_link_id: null,
      properties: { order_id: 'o1', product_code: 'planner_pack', stars_amount: 500, usd_equiv: 6.5 },
      dedup_key: null,
    });
    // guard cancel_if: purchased_product проверяется на КАЖДОМ шаге — branch
    // для покупателя недостижим (PRD belt-and-suspenders)
    const step3 = await processStep(h.engine, run.id, 3);
    expect(step3?.effect).toBe('guard:purchased_product');
    expect(h.db.runs.find((r) => r.id === run.id)?.status).toBe('cancelled');
  });

  it('branch goto(CODE): синтетический флоу без guard — переход разворачивается', async () => {
    const h = makeEngine();
    h.db.seedFlow('synthetic_branch', {
      trigger: { type: 'event', event: 'menu_opened' },
      conditions: [],
      steps: [
        { action: 'send_message', template: 'ws_value_1', delay_hours: 0 },
        { branch: { if: 'event(purchase_completed) within 72h', then: 'goto(synthetic_b)', else: 'goto(synthetic_c)' } },
      ],
      guard: { cancel_if: [] },
    });
    h.db.seedFlow('synthetic_b', {
      trigger: { type: 'manual' },
      conditions: [],
      steps: [{ action: 'send_message', template: 'ws_value_2', delay_hours: 0 }],
      guard: { cancel_if: [] },
    });
    const userId = await withUser(h, '713');
    await onEvent(h.engine, { name: 'menu_opened', userId, properties: {} });
    const run = h.db.activeRunOf('synthetic_branch', userId)!;
    expect(run).toBeDefined();
    await processStep(h.engine, run.id, 0);
    // покупка была → then-ветка: goto(synthetic_b)
    h.db.events.push({
      name: 'purchase_completed',
      user_id: userId,
      tracking_link_id: null,
      properties: { order_id: 'o9', product_code: 'planner_pack', stars_amount: 500, usd_equiv: 6.5 },
      dedup_key: null,
    });
    const step1 = await processStep(h.engine, run.id, 1);
    expect(step1?.effect).toContain('branch→synthetic_b (started)');
    const runB = h.db.activeRunOf('synthetic_b', userId);
    expect(runB).toBeDefined();
    expect(h.db.runs.find((r) => r.id === run.id)?.status).toBe('completed');
  });

  it('checkout_abandonment: триггер checkout_opened; условие «нет покупки 48h» обязательно', async () => {
    const h = makeEngine();
    const userId = await withUser(h, '702');
    const noPurchase = await onEvent(h.engine, {
      name: 'checkout_opened',
      userId,
      properties: { product_code: 'planner_pack', stars_amount: 500 },
    });
    expect(noPurchase).toHaveLength(1); // условие выполнено: покупок нет

    const withPurchase = makeEngine();
    const uid2 = await withUser(withPurchase, '703');
    withPurchase.db.events.push({
      name: 'purchase_completed',
      user_id: uid2,
      tracking_link_id: null,
      properties: { order_id: 'o2', product_code: 'planner_pack', stars_amount: 500, usd_equiv: 6.5 },
      dedup_key: null,
    });
    const starts2 = await onEvent(withPurchase.engine, {
      name: 'checkout_opened',
      userId: uid2,
      properties: { product_code: 'planner_pack', stars_amount: 500 },
    });
    expect(starts2).toHaveLength(0); // условие «no event(purchase) within 48h» ложно
  });

  it('winback: state_changed{to:at_risk}; guard 30 дней блокирует повтор (§28.6)', async () => {
    const h = makeEngine();
    const userId = await withUser(h, '704');
    const first = await onEvent(h.engine, {
      name: 'user_state_changed',
      userId,
      properties: { from: 'engaged', to: 'at_risk' },
    });
    expect(first[0]!.skipped).toBeNull();
    const run = h.db.activeRunOf('winback_v1', userId)!;
    await processStep(h.engine, run.id, 0); // единственный шаг → прогон завершён
    expect(h.db.runs.find((r) => r.id === run.id)?.status).toBe('completed');
    const second = await onEvent(h.engine, {
      name: 'user_state_changed',
      userId,
      properties: { from: 'engaged', to: 'at_risk' },
    });
    expect(second[0]!.skipped).toBe('repeat_guard'); // §28.6: окно 30 дней
    // чужой state_changed (не at_risk) не триггерит
    const other = makeEngine();
    const uid = await withUser(other, '705');
    const none = await onEvent(other.engine, {
      name: 'user_state_changed',
      userId: uid,
      properties: { from: 'new', to: 'onboarded' },
    });
    expect(none).toHaveLength(0);
  });

  it('guard cancel_if: user_blocked / unsubscribed / purchased_product гасят прогон', async () => {
    const h = makeEngine();
    const userId = await withUser(h, '706');
    await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S1' } });
    const run = h.db.runs[0]!;
    await processStep(h.engine, run.id, 0);

    // блокировка между шагами
    h.db.users.get(userId)!.is_blocked = true;
    const blocked = await processStep(h.engine, run.id, 1);
    expect(blocked?.effect).toBe('guard:user_blocked');
    expect(h.db.runs.find((r) => r.id === run.id)?.status).toBe('cancelled');

    // отписка и покупка — до старта
    const h2 = makeEngine();
    const uid2 = await withUser(h2, '707');
    await h2.db.executor.execute(
      `INSERT INTO user_segments (user_id, segment_id, origin) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`,
      [uid2, h2.db.segments.get('unsubscribed')!.id],
    );
    const res2 = await onEvent(h2.engine, { name: 'onboarding_completed', userId: uid2, properties: { segment_code: 'S1' } });
    expect(res2[0]!.skipped).toBe('guard:unsubscribed');

    const h3 = makeEngine();
    const uid3 = await withUser(h3, '708');
    h3.db.events.push({
      name: 'purchase_completed',
      user_id: uid3,
      tracking_link_id: null,
      properties: { order_id: 'o3', product_code: 'planner_pack', stars_amount: 500, usd_equiv: 6.5 },
      dedup_key: null,
    });
    const res3 = await onEvent(h3.engine, { name: 'onboarding_completed', userId: uid3, properties: { segment_code: 'S1' } });
    expect(res3[0]!.skipped).toBe('guard:purchased_product');
  });

  it('дедуп шага {flow_run}:{step}: повтор processStep не дублирует отправку', async () => {
    const h = makeEngine();
    const userId = await withUser(h, '709');
    await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S3' } });
    const run = h.db.runs[0]!;
    await processStep(h.engine, run.id, 0);
    await processStep(h.engine, run.id, 0); // дубль (джоба пришла дважды)
    expect(h.db.outbox.filter((o) => o.template_code === 'ws_value_1')).toHaveLength(1);
  });

  it('дедуп прогона: активный run того же флоу не пересоздаётся', async () => {
    const h = makeEngine();
    const userId = await withUser(h, '710');
    await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S1' } });
    await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S1' } });
    expect(h.db.runs).toHaveLength(1);
  });

  it('версии: draft-версия игнорируется, активная выбирается', async () => {
    const h = makeEngine();
    db_seedDraft(h);
    const userId = await withUser(h, '711');
    const starts = await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S1' } });
    expect(starts).toHaveLength(1);
    const run = h.db.runs[0]!;
    expect(h.db.flows.get(run.flow_id)?.version).toBe(1); // активная v1, не draft v2
    function db_seedDraft(harness: Harness): void {
      harness.db.seedFlow('welcome_series_v1', seedDef('welcome_series_v1'), 'draft', 2);
    }
  });

  it('rehydrate: активные прогоны перепланируются на next_fire_at (идемпотентно)', async () => {
    const h = makeEngine();
    const userId = await withUser(h, '712');
    await onEvent(h.engine, { name: 'onboarding_completed', userId, properties: { segment_code: 'S1' } });
    const run = h.db.runs[0]!;
    const fireAt = new Date(Date.now() + 10_000);
    await h.db.executor.execute(
      `UPDATE flow_runs SET current_step = $2, context = jsonb_set(COALESCE(context, '{}'::jsonb), '{next_fire_at}', $3::jsonb, true) WHERE id = $1`,
      [run.id, 1, JSON.stringify(fireAt.toISOString())],
    );
    const r1 = await rehydrateActiveRuns(h.engine);
    const r2 = await rehydrateActiveRuns(h.engine); // повтор — не дублирует
    expect(r1).toEqual({ runs: 1, scheduled: 1 });
    expect(r2).toEqual({ runs: 1, scheduled: 1 });
    expect(h.scheduled.filter((s) => s.runId === run.id && s.step === 1)).toHaveLength(1);
  });
});

describe('чистые функции движка', () => {
  it('parseEventExpr: event/no event/within; мусор → null', () => {
    expect(parseEventExpr('event(purchase_completed) within 72h')).toEqual({
      negated: false,
      event: 'purchase_completed',
      hours: 72,
    });
    expect(parseEventExpr('no event(purchase_completed) within 48h')).toEqual({
      negated: true,
      event: 'purchase_completed',
      hours: 48,
    });
    expect(parseEventExpr('levenshtein(x)')).toBeNull();
  });

  const ctx: EngineCtx = {
    facts: {
      lifecycle_state: 'onboarded',
      message_frequency: 'normal',
      locale: 'en',
      interest_segment: 'S1',
      is_blocked: false,
      first_name: 'Anna',
    },
    segments: new Set(['S1', 'cold']),
    counter: async (event, hours) => (event === 'purchase_completed' && hours === 72 ? 1 : 0),
  };

  it('conditions: field eq/in/not_in; expr с счётчиком; неизвестное поле/выражение → false', async () => {
    expect(await evalCondition({ field: 'user.message_frequency', op: 'eq', value: 'normal' }, ctx)).toBe(true);
    expect(await evalCondition({ field: 'user.segment', op: 'in', value: ['S1', 'S3'] }, ctx)).toBe(true);
    expect(await evalCondition({ field: 'user.segment', op: 'not_in', value: ['S1'] }, ctx)).toBe(false);
    expect(await evalCondition({ field: 'user.lifecycle_state', op: 'ne', value: 'new' }, ctx)).toBe(true);
    expect(await evalCondition({ expr: 'event(purchase_completed) within 72h' }, ctx)).toBe(true);
    expect(await evalCondition({ expr: 'no event(purchase_completed) within 72h' }, ctx)).toBe(false);
    expect(await evalCondition({ field: 'user.secret', op: 'eq', value: 1 }, ctx)).toBe(false);
    expect(await evalCondition({ expr: 'gibberish' }, ctx)).toBe(false);
  });

  it('guard cancel_if по контексту', async () => {
    expect(await guardCancelReason(['user_blocked'], ctx)).toBeNull();
    expect(await guardCancelReason(['user_blocked'], { ...ctx, facts: { ...ctx.facts, is_blocked: true } })).toBe('user_blocked');
    expect(await guardCancelReason(['unsubscribed'], ctx)).toBeNull();
    expect(
      await guardCancelReason(['unsubscribed'], { ...ctx, segments: new Set(['S1', 'unsubscribed']) }),
    ).toBe('unsubscribed');
    expect(await guardCancelReason(['purchased_product'], ctx)).toBeNull();
    expect(
      await guardCancelReason(['purchased_product'], {
        ...ctx,
        counter: async () => 1,
      }),
    ).toBe('purchased_product');
  });

  it('triggerMatchesEvent: все типы триггеров', () => {
    expect(triggerMatchesEvent({ type: 'event', event: 'checkout_opened' }, { name: 'checkout_opened', properties: {} })).toBe(true);
    expect(triggerMatchesEvent({ type: 'event', event: 'checkout_opened' }, { name: 'menu_opened', properties: {} })).toBe(false);
    expect(
      triggerMatchesEvent({ type: 'segment_entered', segment: 'intent_high' }, { name: 'segment_assigned', properties: { segment_code: 'intent_high' } }),
    ).toBe(true);
    expect(
      triggerMatchesEvent({ type: 'state_changed', to: 'at_risk' }, { name: 'user_state_changed', properties: { from: 'engaged', to: 'at_risk' } }),
    ).toBe(true);
    expect(triggerMatchesEvent({ type: 'schedule', cron: '0 * * * *' }, { name: 'menu_opened', properties: {} })).toBe(false);
  });

  it('parseFlowDefinition: некорректная схема → null', () => {
    expect(parseFlowDefinition({ trigger: { type: 'event', event: 'x' }, steps: [] })).toBeNull();
    expect(parseFlowDefinition(seedDef('welcome_series_v1'))).not.toBeNull();
    expect(parseFlowDefinition(seedDef('checkout_abandonment_v1'))).not.toBeNull();
    expect(parseFlowDefinition(seedDef('winback_v1'))).not.toBeNull();
  });
});
