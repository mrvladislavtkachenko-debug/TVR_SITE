import { describe, expect, it } from 'vitest';
import { buildServer, type ComponentState, type HealthChecks } from '../src/server.js';

const up = (): Promise<ComponentState> => Promise.resolve('up');
const down = (): Promise<ComponentState> => Promise.resolve('down');

describe('GET /health (apps/bot, :4100)', () => {
  it('200 ok', async () => {
    const checks: HealthChecks = { db: up, queue: up };
    const app = await buildServer({ checks, logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up', queue: 'up' });
    await app.close();
  });

  it('503 degraded при redis down', async () => {
    const checks: HealthChecks = { db: up, queue: down };
    const app = await buildServer({ checks, logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'up', queue: 'down' });
    await app.close();
  });

  it('404 envelope на неизвестном маршруте', async () => {
    const app = await buildServer({ checks: { db: up, queue: up }, logger: false });
    const res = await app.inject({ method: 'GET', url: '/webhook/telegram' });
    expect(res.statusCode).toBe(404); // роут появится в M5
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    await app.close();
  });
});
