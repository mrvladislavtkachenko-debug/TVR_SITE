import { describe, expect, it } from 'vitest';
import { enqueueOutbox } from '@tas/db/services';
import { nextUtcMidnight, sendOutboxRow } from '../src/senderCore.js';
import { TelegramApiError } from '../src/telegram.js';
import { WorkerFakeDb } from './helpers/workerFakeDb.js';
import { FakeTransport, MemoryLogger } from '../../bot/test/helpers/harness.js';

/**
 * Ядро отправителя (мигрировано из apps/bot): daily cap, 403-каскад, 429,
 * lead_magnet_delivered, терминальные 4xx.
 */

function makeDeps(db: WorkerFakeDb, transport: FakeTransport) {
  return { deps: { executor: db.executor, transport, log: new MemoryLogger() }, transport };
}

async function enqueueFlowMsg(db: WorkerFakeDb, userId: string, over: Record<string, unknown> = {}): Promise<string> {
  await enqueueOutbox(db.executor, [
    {
      userId,
      kind: (over.kind as 'flow') ?? 'flow',
      templateCode: (over.template_code as string) ?? 'ws_value_1',
      payload: { chat_id: (over.chat_id as string) ?? '111', text: 'advice' },
      dedupKey: (over.dedup_key as string) ?? null,
    },
  ]);
  return db.outbox.at(-1)!.id;
}

describe('OutboxSender core — дневной cap (§13.2)', () => {
  it('flow-сообщение сверх cap → capped, перенос на следующую UTC-полночь', async () => {
    const db = new WorkerFakeDb();
    db.users.set('1', newUser('1', '111'));
    const { deps } = makeDeps(db, new FakeTransport());
    // первая отправка сегодня уже была
    await enqueueFlowMsg(db, '1');
    db.outbox[0]!.status = 'sent';
    db.outbox[0]!.sent_at = new Date();

    await enqueueFlowMsg(db, '1');
    const second = db.outbox[1]!;
    const outcome = await sendOutboxRow(deps, second, '111', { dailyCap: 1 });
    expect(outcome.kind).toBe('capped');
    expect(second.status).toBe('pending'); // не отправлено
    expect(second.error).toContain('daily cap reached (1/1)');
    const midnight = nextUtcMidnight();
    expect(second.scheduled_at.getTime()).toBeGreaterThanOrEqual(midnight.getTime() - 1000);
    expect(second.scheduled_at.getTime()).toBeLessThan(midnight.getTime() + 60_000);
    expect(deps.transport.sent).toHaveLength(0);
  });

  it('transactional НЕ считается в cap и отправляется', async () => {
    const db = new WorkerFakeDb();
    db.users.set('1', newUser('1', '111'));
    const { deps } = makeDeps(db, new FakeTransport());
    await enqueueFlowMsg(db, '1');
    db.outbox[0]!.status = 'sent';
    db.outbox[0]!.sent_at = new Date();

    await enqueueOutbox(db.executor, [
      { userId: '1', kind: 'transactional', templateCode: 'bot_menu', payload: { chat_id: '111', text: 'menu' } },
    ]);
    const tx = db.outbox[1]!;
    const outcome = await sendOutboxRow(deps, tx, '111', { dailyCap: 1 });
    expect(outcome.kind).toBe('sent');
    expect(tx.status).toBe('sent');
  });

  it('nextUtcMidnight: следующая полночь UTC', () => {
    const now = new Date(Date.UTC(2026, 7, 29, 15, 30));
    const midnight = nextUtcMidnight(now);
    expect(midnight.toISOString()).toBe('2026-08-30T00:00:00.000Z');
  });
});

describe('OutboxSender core — ошибки Telegram', () => {
  it('успех: sent + telegram_message_id + lead_magnet_delivered для документа', async () => {
    const db = new WorkerFakeDb();
    db.users.set('1', newUser('1', '111'));
    const { deps } = makeDeps(db, new FakeTransport());
    await enqueueOutbox(db.executor, [
      {
        userId: '1',
        kind: 'transactional',
        templateCode: 'bot_welcome_doc',
        payload: { chat_id: '111', document: { url: 'https://x/lm.pdf', filename: 'lm.pdf' }, delivery_kind: 'file' },
      },
    ]);
    const row = db.outbox[0]!;
    const outcome = await sendOutboxRow(deps, row, '111', { dailyCap: 1 });
    expect(outcome.kind).toBe('sent');
    expect(row.status).toBe('sent');
    const lm = db.eventsByName('lead_magnet_delivered');
    expect(lm).toHaveLength(1);
    expect(lm[0]!.dedup_key).toBe(`outbox:${row.id}:lead_magnet_delivered`);
    expect(lm[0]!.properties).toEqual({ delivery_kind: 'file' });
  });

  it('§28.5 403: каскад — blocked, отмена runs, ВЕСЬ outbox skipped, события', async () => {
    const db = new WorkerFakeDb();
    db.users.set('1', newUser('1', '111'));
    db.profiles.set('1', newProfile('1', 'onboarded'));
    db.runs.push({ id: '9', flow_id: 'f', flow_version: 1, user_id: '1', status: 'active', current_step: 0, context: {}, started_at: new Date(), finished_at: null });
    const transport = new FakeTransport();
    transport.errors.push(new TelegramApiError(403, 'Forbidden: bot was blocked by the user'));
    const { deps } = makeDeps(db, transport);
    const blockedId = await enqueueFlowMsg(db, '1');
    await enqueueFlowMsg(db, '1');

    const row = db.outbox.find((o) => o.id === blockedId)!;
    const outcome = await sendOutboxRow(deps, row, '111', { dailyCap: 0 });
    expect(outcome.kind).toBe('blocked');
    await new Promise((r) => setTimeout(r, 10)); // каскад асинхронен
    expect(db.users.get('1')!.is_blocked).toBe(true);
    expect(db.profiles.get('1')!.lifecycle_state).toBe('blocked');
    expect(db.runs[0]!.status).toBe('cancelled');
    expect(db.outbox.every((o) => o.status === 'skipped' || o.id === blockedId)).toBe(true);
    expect(db.outbox.find((o) => o.id === blockedId)!.status).toBe('failed');
    expect(db.eventsByName('bot_blocked')).toHaveLength(1);
    expect(db.eventsByName('user_state_changed')[0]!.properties).toEqual({ from: 'onboarded', to: 'blocked' });
  });

  it('429: retryable с retryAfter → retryAt в будущем', async () => {
    const db = new WorkerFakeDb();
    db.users.set('1', newUser('1', '111'));
    const transport = new FakeTransport();
    transport.errors.push(new TelegramApiError(429, 'Too Many Requests: retry after 7', 7));
    const { deps } = makeDeps(db, transport);
    await enqueueFlowMsg(db, '1');
    const outcome = await sendOutboxRow(deps, db.outbox[0]!, '111', { dailyCap: 0 });
    expect(outcome.kind).toBe('retryable');
    if (outcome.kind === 'retryable') {
      expect(outcome.error).toContain('429');
      expect(outcome.retryAt!.getTime()).toBeGreaterThan(Date.now() + 6000);
    }
  });

  it('терминальный 4xx (400): failed без ретраев', async () => {
    const db = new WorkerFakeDb();
    db.users.set('1', newUser('1', '111'));
    const transport = new FakeTransport();
    transport.errors.push(new TelegramApiError(400, 'Bad Request: chat not found'));
    const { deps } = makeDeps(db, transport);
    await enqueueFlowMsg(db, '1');
    const outcome = await sendOutboxRow(deps, db.outbox[0]!, '111', { dailyCap: 0 });
    expect(outcome.kind).toBe('failed');
    expect(db.outbox[0]!.status).toBe('failed');
  });
});

function newUser(id: string, telegramId: string) {
  return {
    id,
    telegram_id: telegramId,
    username: null,
    first_name: 'Anna',
    locale: 'en',
    is_blocked: false,
    blocked_at: null,
    first_seen_at: new Date(),
  };
}

function newProfile(userId: string, state: string) {
  return {
    user_id: userId,
    lifecycle_state: state,
    fsm_state: null,
    interest_segment_id: null,
    message_frequency: 'normal' as const,
    onboarding_completed_at: new Date(),
  };
}
