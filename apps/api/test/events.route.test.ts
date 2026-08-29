import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { registerEventsRoute, type EventsRouteDeps } from '../src/routes/events.js';
import { createMemoryRateCounter } from '../src/ratelimit.js';
import type { EventInsert, SqlExecutor, TrackingLinkRow } from '@tas/db/services';

async function setup(opts: {
  link?: TrackingLinkRow | null;
  executeError?: Error;
  queryError?: Error;
  limit?: number;
}): Promise<{ app: FastifyInstance; inserted: EventInsert[] }> {
  const inserted: EventInsert[] = [];
  const executor: SqlExecutor = {
    async query(sql) {
      if (opts.queryError) throw opts.queryError;
      if (sql.includes('FROM tracking_links')) {
        return opts.link ? { rows: [opts.link], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async execute(_sql, params) {
      if (opts.executeError) throw opts.executeError;
      inserted.push({
        name: String(params[0]),
        userId: null,
        trackingLinkId: params[2] === null ? null : String(params[2]),
        occurredAt: new Date(),
        properties: JSON.parse(String(params[4])) as Record<string, unknown>,
        dedupKey: params[5] === null ? null : String(params[5]),
      });
      return 1;
    },
  };
  const deps: EventsRouteDeps = {
    executor,
    rateCounter: createMemoryRateCounter(),
    ipHashSalt: 'test-salt',
    tokenFormat: { prefix: 't1', length: 10 },
    limit: opts.limit ?? 60,
  };
  const app = await buildServer({
    checks: { db: async () => 'up', queue: async () => 'up' },
    logger: false,
    routes: (a) => registerEventsRoute(a, deps),
  });
  return { app, inserted };
}

const LINK: TrackingLinkRow = {
  id: '42',
  short_code: 't1aB9xK2mQz7',
  source_id: 'pinterest',
  campaign_id: null,
  cluster_id: null,
  keyword_id: null,
  pin_id: '11',
  landing_slug: 'morning-checklist',
  creative_variant: 'A',
  landing_variant: null,
  placement: null,
};

describe('POST /api/v1/events (харднинг M4: публично только telegram_click)', () => {
  it('telegram_click → 202 + серверное обогащение (ip_hash, ua_class, dedup_key, tracking_link_id)', async () => {
    const { app, inserted } = await setup({ link: LINK });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'user-agent': 'Pinterest/17.0 iPhone' },
      payload: { name: 'telegram_click', properties: { slug: 'morning-checklist', token: LINK.short_code, session_id: 'sess12345678' } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    const ev = inserted[0]!;
    expect(ev.name).toBe('telegram_click');
    expect(ev.trackingLinkId).toBe('42');
    expect(ev.dedupKey).toMatch(/^telegram_click:t1aB9xK2mQz7:sess12345678:\d+$/);
    const props = ev.properties ?? {};
    expect(props.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(props.ua_class).toBe('pinterest_app');
    await app.close();
  });

  it('link_click публично → 403 FORBIDDEN (server-side only)', async () => {
    const { app, inserted } = await setup({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'link_click', properties: { slug: 'x', token: 't1aB9xK2mQz7' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(inserted).toHaveLength(0);
    await app.close();
  });

  it('bridge_view публично → 403', async () => {
    const { app } = await setup({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'bridge_view', properties: { slug: 'x', token: 't1aB9xK2mQz7' } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('неизвестное имя → 400 VALIDATION_ERROR', async () => {
    const { app } = await setup({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'purchase_completed', properties: { slug: 'x', token: 't' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('битые properties → 400', async () => {
    const { app } = await setup({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'telegram_click', properties: { token: 't1aB9xK2mQz7' } }, // нет slug
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('превышение лимита → 429 + Retry-After', async () => {
    const { app } = await setup({ limit: 2 });
    const payload = { name: 'telegram_click', properties: { slug: 'x', token: 't1aB9xK2mQz7' } };
    await app.inject({ method: 'POST', url: '/api/v1/events', payload });
    await app.inject({ method: 'POST', url: '/api/v1/events', payload });
    const res = await app.inject({ method: 'POST', url: '/api/v1/events', payload });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('ошибка резолва (БД недоступна) → tracking_link_id null, 202', async () => {
    const { app, inserted } = await setup({ queryError: new Error('db down') });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'telegram_click', properties: { slug: 'x', token: 't1aB9xK2mQz7' } },
    });
    expect(res.statusCode).toBe(202);
    expect(inserted[0]?.trackingLinkId).toBeNull();
    await app.close();
  });

  it('ошибка записи БД → всё равно 202 (best-effort beacon, Э7)', async () => {
    const { app } = await setup({ executeError: new Error('db down') });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'telegram_click', properties: { slug: 'x', token: 't1aB9xK2mQz7' } },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
