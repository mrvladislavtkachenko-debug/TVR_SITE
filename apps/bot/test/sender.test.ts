import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@tas/db/services';
import { enqueueOutbox } from '@tas/db/services';
import { OutboxSender } from '../src/outboxSender.js';
import { TelegramApiError } from '../src/telegram.js';
import { FakeBotDb, seedBotTemplates } from './helpers/fakeDb.js';
import { FakeTransport, MemoryLogger } from './helpers/harness.js';

/** Отправитель outbox (M5: прямой, 1/s на чат; 403/429 — §28.5/28.15). */

function makeSender(db: FakeBotDb, transport: FakeTransport, perChatIntervalMs = 1000) {
  return new OutboxSender(
    { executor: db.executor as SqlExecutor, transport, log: new MemoryLogger() },
    { perChatIntervalMs, batchSize: 10 },
  );
}

async function enqueueOne(db: FakeBotDb, over: Record<string, unknown> = {}): Promise<string> {
  await enqueueOutbox(db.executor, [
    {
      userId: (over.user_id as string) ?? '1',
      kind: (over.kind as 'flow') ?? 'transactional',
      templateCode: (over.template_code as string) ?? null,
      payload: { chat_id: (over.chat_id as string) ?? '111', text: 'hello', ...('payload' in over ? (over.payload as object) : {}) },
      dedupKey: (over.dedup_key as string) ?? null,
    },
  ]);
  return db.outbox.at(-1)!.id;
}

describe('OutboxSender', () => {
  it('успешная отправка: sent + telegram_message_id; лид-магнит даёт событие', async () => {
    const db = new FakeBotDb();
    seedBotTemplates(db);
    const transport = new FakeTransport();
    db.users.set('1', {
      id: '1',
      telegram_id: '111',
      username: null,
      first_name: null,
      locale: null,
      is_blocked: false,
      blocked_at: null,
    });
    const sender = makeSender(db, transport, 0);
    await enqueueOne(db, { payload: { chat_id: '111', text: 'hi' } });
    await enqueueOutbox(db.executor, [
      {
        userId: '1',
        kind: 'transactional',
        templateCode: 'bot_welcome_doc',
        payload: { chat_id: '111', document: { url: 'https://x/lm.pdf', filename: 'lm.pdf' }, delivery_kind: 'file' },
      },
    ]);
    // пейсинг: ≤1 сообщение на чат за тик — второй тик забирает второе
    const res1 = await sender.tick();
    expect(res1.sent).toBe(1);
    const res = await sender.tick();
    expect(res.sent).toBe(1);
    expect(transport.sent.map((s) => s.method)).toEqual(['sendMessage', 'sendDocument']);
    const rows = db.outbox;
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.telegram_message_id).not.toBeNull();
    expect(db.eventsByName('lead_magnet_delivered')).toHaveLength(1);
    expect(db.eventsByName('lead_magnet_delivered')[0]!.properties).toEqual({ delivery_kind: 'file' });
    expect(db.eventsByName('lead_magnet_delivered')[0]!.dedup_key).toBe(`outbox:${rows[1]!.id}:lead_magnet_delivered`);
  });

  it('пейсинг 1/s на чат: второе сообщение чата откладывается, другой чат уходит', async () => {
    const db = new FakeBotDb();
    const transport = new FakeTransport();
    const sender = makeSender(db, transport);
    await enqueueOne(db, { payload: { chat_id: '222', text: 'a' } });
    await enqueueOne(db, { payload: { chat_id: '222', text: 'b' } });
    await enqueueOne(db, { payload: { chat_id: '333', text: 'c' } });
    const res = await sender.tick();
    expect(res.sent).toBe(2);
    expect(res.deferred).toBe(1);
    const deferred = db.outbox.find((o) => o.status === 'pending');
    expect(deferred?.error).toContain('paced');
    expect(deferred?.scheduled_at.getTime()).toBeGreaterThan(Date.now() - 50);
  });

  it('429: строка отложена на retry_after+1s, отправитель на паузе', async () => {
    const db = new FakeBotDb();
    const transport = new FakeTransport();
    transport.errors.push(
      new TelegramApiError(429, 'Too Many Requests: retry after 7', 7),
    );
    const sender = makeSender(db, transport);
    await enqueueOne(db);
    const res = await sender.tick();
    expect(res.sent).toBe(0);
    const row = db.outbox[0]!;
    expect(row.status).toBe('pending');
    expect(row.error).toContain('429');
    expect(row.scheduled_at.getTime()).toBeGreaterThan(Date.now() + 6000);
    // глобальная пауза: новый тик не захватывает
    await enqueueOne(db, { payload: { chat_id: '999', text: 'x' } });
    const res2 = await sender.tick();
    expect(res2.claimed).toBe(0);
  });

  it('§28.5 403: is_blocked, lifecycle blocked, flow_runs отменены, outbox skipped, bot_blocked', async () => {
    const db = new FakeBotDb();
    db.users.set('1', {
      id: '1',
      telegram_id: '111',
      username: null,
      first_name: null,
      locale: null,
      is_blocked: false,
      blocked_at: null,
    });
    db.profiles.set('1', {
      user_id: '1',
      lifecycle_state: 'onboarded',
      fsm_state: null,
      interest_segment_id: null,
      message_frequency: 'normal',
      onboarding_completed_at: new Date(),
    });
    db.flowRuns.push({ id: '9', user_id: '1', status: 'active' });
    const transport = new FakeTransport();
    transport.errors.push(new TelegramApiError(403, 'Forbidden: bot was blocked by the user'));
    const sender = makeSender(db, transport);
    const blockedId = await enqueueOne(db);
    await enqueueOutbox(db.executor, [
      { userId: '1', kind: 'flow', payload: { chat_id: '111', text: 'advice 1' } },
      { userId: '1', kind: 'broadcast', payload: { chat_id: '111', text: 'news' } },
    ]);

    const res = await sender.tick();
    expect(res.sent).toBe(0);
    expect(db.users.get('1')!.is_blocked).toBe(true);
    expect(db.users.get('1')!.blocked_at).not.toBeNull();
    expect(db.profiles.get('1')!.lifecycle_state).toBe('blocked');
    expect(db.flowRuns[0]!.status).toBe('cancelled');
    expect(db.outbox.find((o) => o.id === blockedId)!.status).toBe('failed');
    expect(db.outbox.filter((o) => o.status === 'skipped')).toHaveLength(2);
    const blockedEv = db.eventsByName('bot_blocked')[0]!;
    expect(blockedEv.properties).toEqual({ last_flow_code: null });
    expect(db.eventsByName('user_state_changed')[0]!.properties).toEqual({ from: 'onboarded', to: 'blocked' });
  });

  it('сетевая ошибка: 3 попытки с отсрочкой, затем failed', async () => {
    const db = new FakeBotDb();
    const transport = new FakeTransport();
    transport.errors.push(new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'));
    const sender = makeSender(db, transport);
    await enqueueOne(db);
    await sender.tick();
    expect(db.outbox[0]!.status).toBe('pending'); // ретрай №1 отложен
    db.outbox[0]!.scheduled_at = new Date(Date.now() - 1000); // имитируем наступление срока
    await sender.tick();
    expect(db.outbox[0]!.status).toBe('pending'); // ретрай №2
    db.outbox[0]!.scheduled_at = new Date(Date.now() - 1000);
    await sender.tick();
    expect(db.outbox[0]!.status).toBe('failed');
    expect(db.outbox[0]!.error).toContain('attempts exhausted');
  });

  it('dedup_key: повторная постановка с тем же ключом не создаёт строку', async () => {
    const db = new FakeBotDb();
    await enqueueOne(db, { dedup_key: '1:lm:onboarding' });
    await enqueueOne(db, { dedup_key: '1:lm:onboarding' });
    expect(db.outbox).toHaveLength(1);
  });
});
