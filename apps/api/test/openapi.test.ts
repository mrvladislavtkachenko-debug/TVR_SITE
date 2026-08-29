import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { registerAdminRoutes } from '../src/routes/admin/index.js';
import { registerEventsRoute } from '../src/routes/events.js';
import { createMemoryRateCounter } from '../src/ratelimit.js';
import { createMemoryCounterStore } from '../src/auth/lockout.js';
import { createMemoryIdempotencyStore } from '../src/idempotency.js';
import type { SqlExecutor } from '@tas/db/services';

/**
 * Drift-чек OpenAPI (§39.6): каждый path+method из спеки существует в app.
 */

const stubExecutor: SqlExecutor = {
  async query() {
    return { rows: [], rowCount: 0 };
  },
  async execute() {
    return 1;
  },
};

async function buildApp(): Promise<FastifyInstance> {
  return buildServer({
    checks: { db: async () => 'up', queue: async () => 'up' },
    logger: false,
    routes: (app) => {
      registerEventsRoute(app, {
        executor: stubExecutor,
        rateCounter: createMemoryRateCounter(),
        ipHashSalt: 'salt',
        tokenFormat: { prefix: 't1', length: 10 },
      });
      registerAdminRoutes(app, {
        executor: stubExecutor,
        jwtSecret: 'jwt-secret-0123456789abcdef0123456789',
        encryptionKey: 'enc-key-32-chars-minimum-worth!!',
        lockoutStore: createMemoryCounterStore(),
        loginRateCounter: createMemoryRateCounter(),
        idempotency: createMemoryIdempotencyStore(),
        tokenFormat: { prefix: 't1', length: 10 },
        publicBaseUrl: 'https://tvrs.io',
        botUsername: 'TASDevBot',
      });
    },
  });
}

describe('OpenAPI drift', () => {
  it('все пути спеки существуют в приложении', async () => {
    const app = await buildApp();
    const spec = JSON.parse(
      readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> };

    const missing: string[] = [];
    for (const [specPath, methods] of Object.entries(spec.paths)) {
      // /events → /api/v1/events; /admin/... → /api/v1/admin/...; /health как есть; {id} → :id
      let routePath: string;
      if (specPath === '/health') routePath = '/health';
      else routePath = `/api/v1${specPath}`.replace(/\{(\w+)\}/g, ':$1');

      for (const method of Object.keys(methods)) {
        const ok = app.hasRoute({ method: method.toUpperCase(), url: routePath } as never);
        if (!ok) missing.push(`${method.toUpperCase()} ${routePath}`);
      }
    }
    expect(missing).toEqual([]);
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(9);
    await app.close();
  });
});
