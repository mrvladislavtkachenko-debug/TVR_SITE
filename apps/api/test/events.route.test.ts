import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { registerEventsRoute, type EventsRouteDeps } from '../src/routes/events.js';
import { createMemoryRateCounter } from '../src/ratelimit.js';
import type { EventInsert, SqlExecutor, TrackingLinkRow } from '@tas/db';

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
        return opts.link
          ? { rows: [opts.link], rowCount: 1 }
          : { rows: [], rowCount: 0 };
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
    salt: 'test-salt',
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

describe('POST /api/v1/events', () => {
  it('202 + запись с серверным обогащением (ip_hash, ua_class, dedup_key, tracking_link_id)', async () => {
    const { app, inserted } = await setup({ link: LINK });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'user-agent': 'Pinterest/17.0 iPhone', referer: 'https://pinterest.com/pin/123' },
      payload: { name: 'link_click', properties: { slug: 'morning-checklist', token: LINK.short_code } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    expect(inserted).toHaveLength(1);
    const ev = inserted[0]!;
    expect(ev.name).toBe('link_click');
    expect(ev.trackingLinkId).toBe('42');
    expect(ev.dedupKey).toMatch(/^link_click:t1aB9xK2mQz7:[0-9a-f]{64}:\d+$/);
    const props = ev.properties ?? {};
    expect(props.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(props.ua_class).toBe('pinterest_app');
    expect(props.referer_host).toBe('pinterest.com');
    await app.close();
  });

  it('неизвестный токен → tracking_link_id null, всё равно 202', async () => {
    const { app, inserted } = await setup({ link: null });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'telegram_click', properties: { slug: 'x', token: 't1aB9xK2mQz7' } },
    });
    expect(res.statusCode).toBe(202);
    expect(inserted[0]?.trackingLinkId).toBeNull();
    await app.close();
  });

  it('невалидное тело → 400 VALIDATION_ERROR', async () => {
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

  it('превышение лимита → 429 + Retry-After', async () => {
    const { app } = await setup({ limit: 2 });
    const payload = { name: 'bridge_view', properties: { slug: 'x', token: 't1aB9xK2mQz7' } };
    await app.inject({ method: 'POST', url: '/api/v1/events', payload });
    await app.inject({ method: 'POST', url: '/api/v1/events', payload });
    const res = await app.inject({ method: 'POST', url: '/api/v1/events', payload });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
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

  it('ошибка резолва (БД недоступна) → tracking_link_id null, 202', async () => {
    const { app, inserted } = await setup({ queryError: new Error('db down') });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { name: 'link_click', properties: { slug: 'x', token: 't1aB9xK2mQz7' } },
    });
    expect(res.statusCode).toBe(202);
    expect(inserted[0]?.trackingLinkId).toBeNull();
    await app.close();
  });
});

