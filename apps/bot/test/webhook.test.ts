import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { registerWebhookRoute, secretTokenEqual } from '../src/webhook.js';
import { UpdatePipeline } from '../src/pipeline.js';
import { markUpdateProcessed } from '@tas/db/services';
import { createBot, createTransport } from '../src/telegram.js';
import { registerBotHandlers } from '../src/handlers.js';
import {
  FakeTransport,
  MemoryLogger,
  mapTemplateStore,
  startUpdate,
} from './helpers/harness.js';
import { FakeBotDb, seedBotTemplates } from './helpers/fakeDb.js';
import { MockTelegramServer } from './helpers/mockTelegram.js';

/**
 * Webhook (§22, §28.9/28.12): секрет constant-time, идемпотентность update_id,
 * ACK до обработки, полная цепочка через мок Telegram Bot API по HTTP.
 */

const SECRET = 'unit-webhook-secret-0123456789';

function makeApp(db: FakeBotDb, pipeline: UpdatePipeline): Promise<FastifyInstance> {
  return buildServer({
    checks: { db: async () => 'up', queue: async () => 'up' },
    logger: false,
    routes: (app) => registerWebhookRoute(app, { executor: db.executor, secret: SECRET, pipeline }),
  });
}

describe('webhook /webhook/telegram', () => {
  it('секрет: constant-time сравнение; неверный/отсутствующий → 401', async () => {
    expect(secretTokenEqual(SECRET, SECRET)).toBe(true);
    expect(secretTokenEqual(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretTokenEqual(`${SECRET}x`, SECRET)).toBe(false);

    const db = new FakeBotDb();
    const pipeline = new UpdatePipeline(async () => undefined, new MemoryLogger());
    const app = await makeApp(db, pipeline);
    const update = startUpdate(1, 100);
    const r1 = await app.inject({ method: 'POST', url: '/webhook/telegram', payload: update });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret-value-123456' },
      payload: update,
    });
    expect(r2.statusCode).toBe(401);
    expect(db.telegramUpdates.size).toBe(0); // до проверки секрета тело не обрабатывается
    await app.close();
  });

  it('битый body (нет update_id) → 400', async () => {
    const db = new FakeBotDb();
    const pipeline = new UpdatePipeline(async () => undefined, new MemoryLogger());
    const app = await makeApp(db, pipeline);
    const r = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: { foo: 1 },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('§28.9 идемпотентность: повторная доставка update_id не обрабатывается дважды', async () => {
    const db = new FakeBotDb();
    seedBotTemplates(db);
    const log = new MemoryLogger();
    const transport = new FakeTransport();
    const bot = createBot('123:UNIT');
    bot.botInfo = { id: 1, is_bot: true, first_name: 'TAS', username: 'TASDevBot' } as typeof bot.botInfo;
    registerBotHandlers(bot, {
      executor: db.executor,
      templates: mapTemplateStore(db.templates),
      transport,
      leadMagnet: { url: 'https://files.example.com/lm.pdf', filename: 'lm.pdf' },
      tokenFormat: { prefix: 't1', length: 10 },
      log,
    });
    const pipeline = new UpdatePipeline(async (update, rowId) => {
      await bot.handleUpdate(update);
      await markUpdateProcessed(db.executor, rowId);
    }, log);
    const app = await makeApp(db, pipeline);

    const update = startUpdate(7001, 901);
    const r1 = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: update,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ ok: true });
    const r2 = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: update,
    });
    expect(r2.json()).toEqual({ ok: true, duplicate: true });
    await pipeline.idle();

    expect(db.telegramUpdates.size).toBe(1);
    const stored = [...db.telegramUpdates.values()][0]!;
    expect(stored.processed_at).not.toBeNull();
    expect(db.eventsByName('telegram_start')).toHaveLength(1); // ровно один старт
    await app.close();
  });

  it('§28.12 ACK до обработки: 200 возвращается, пока обработка ещё идёт', async () => {
    const db = new FakeBotDb();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pipeline = new UpdatePipeline(async () => {
      await gate; // имитируем тяжёлую обработку
    }, new MemoryLogger());
    const app = await makeApp(db, pipeline);

    const t0 = Date.now();
    const r = await app.inject({
      method: 'POST',
      url: '/webhook/telegram',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: startUpdate(7002, 902),
    });
    expect(r.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000); // <2s (NFR-1)
    expect(pipeline.pending).toBe(1); // обработка ещё в полёте
    release();
    await pipeline.idle();
    expect(pipeline.pending).toBe(0);
    await app.close();
  });

  describe('webhook → обработка → outbox (отправка — apps/worker, M6)', () => {
    let mock: MockTelegramServer;
    let db: FakeBotDb;
    let app: FastifyInstance;
    let pipeline: UpdatePipeline;

    beforeAll(async () => {
      mock = new MockTelegramServer();
      await mock.start();
      db = new FakeBotDb();
      seedBotTemplates(db);
      const log = new MemoryLogger();
      // реальный grammY-транспорт → apiRoot мок-сервера
      const bot = createBot('123456:MOCKTOKEN', mock.apiRoot);
      bot.botInfo = { id: 1, is_bot: true, first_name: 'TAS', username: 'TASDevBot' } as typeof bot.botInfo;
      const transport = createTransport(bot);
      registerBotHandlers(bot, {
        executor: db.executor,
        templates: mapTemplateStore(db.templates),
        transport,
        leadMagnet: { url: 'https://files.example.com/lm.pdf', filename: 'lm.pdf' },
        tokenFormat: { prefix: 't1', length: 10 },
        log,
      });
      pipeline = new UpdatePipeline(async (update, rowId) => {
        await bot.handleUpdate(update);
        await markUpdateProcessed(db.executor, rowId);
      }, log);
      app = await makeApp(db, pipeline);
    });

    afterAll(async () => {
      await app.close();
      await mock.stop();
    });

    it('webhook → handlers → outbox → sender → Bot API (HTTP): /start с token', async () => {
      db.seedTrackingLink('t1HttpChainx');
      const r = await app.inject({
        method: 'POST',
        url: '/webhook/telegram',
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
        payload: startUpdate(7100, 950, 't1HttpChainx'),
      });
      expect(r.statusCode).toBe(200);
      await pipeline.idle();

      // M6: бот — webhook-only; исходящие ФИКСИРУЮТСЯ в outbox (отправляет
      // apps/worker). Форма строк = контракт с отправителем.
      expect(db.outboxPending()).toHaveLength(2);
      const doc = db.outboxPending().find((o) => o.payload.document);
      expect(doc?.payload.document).toMatchObject({ url: 'https://files.example.com/lm.pdf' });
      expect(doc?.payload.delivery_kind).toBe('file');
      const q1 = db.outboxPending().find((o) => o.payload.text);
      expect((q1?.payload.buttons as { callbackData: string }[]).map((b) => b.callbackData)).toEqual([
        'q1:S1',
        'q1:S2',
        'q1:S3',
        'q1:S4',
      ]);
      expect(db.eventsByName('telegram_start')[0]!.properties.payload_status).toBe('ok');
      expect(mock.calls).toHaveLength(0); // бот ничего не отправляет напрямую
    });
  });
});
