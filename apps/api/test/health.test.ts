import { describe, expect, it } from 'vitest';
import { buildServer, type ComponentState, type HealthChecks } from '../src/server.js';

const up = (): Promise<ComponentState> => Promise.resolve('up');
const down = (): Promise<ComponentState> => Promise.resolve('down');

const checksUp: HealthChecks = { db: up, queue: up };
const checksDbDown: HealthChecks = { db: down, queue: up };
const checksThrowing: HealthChecks = {
  db: () => Promise.reject(new Error('boom')),
  queue: up,
};

describe('GET /health', () => {
  it('200 + {status:ok, db:up, queue:up} когда всё живо', async () => {
    const app = await buildServer({ checks: checksUp, logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up', queue: 'up' });
    await app.close();
  });

  it('503 + degraded когда db down', async () => {
    const app = await buildServer({ checks: checksDbDown, logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'down', queue: 'up' });
    await app.close();
  });

  it('бросок проверки не роняет запрос — считается down', async () => {
    const app = await buildServer({ checks: checksThrowing, logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'down', queue: 'up' });
    await app.close();
  });
});

describe('error envelope', () => {
  it('неизвестный маршрут → 404 envelope (§19)', async () => {
    const app = await buildServer({ checks: checksUp, logger: false });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    await app.close();
  });
});
