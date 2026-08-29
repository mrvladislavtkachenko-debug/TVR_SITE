import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { TokenFormat } from '@tas/shared';
import type { KvCache, SqlExecutor } from '@tas/db/services';
import { registerLoginRoute } from './auth.js';
import { registerTrackingLinksRoutes } from './trackingLinks.js';
import { registerPinsRoutes } from './pins.js';
import { registerUsersRoutes } from './users.js';
import { requireRole } from '../../auth/guard.js';
import type { CounterStore } from '../../auth/lockout.js';
import type { IdempotencyStore } from '../../idempotency.js';
import type { RateCounter } from '../../ratelimit.js';

export interface AdminRoutesDeps {
  executor: SqlExecutor;
  cache?: KvCache;
  jwtSecret: string;
  encryptionKey: string;
  tokenTtlSeconds?: number;
  lockoutStore: CounterStore;
  loginRateCounter: RateCounter;
  idempotency: IdempotencyStore;
  tokenFormat: TokenFormat;
  publicBaseUrl: string;
  botUsername: string;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  // публичный (внутри admin-неймспейса) логин — без JWT
  registerLoginRoute(app, {
    executor: deps.executor,
    lockoutStore: deps.lockoutStore,
    loginRateCounter: deps.loginRateCounter,
    jwtSecret: deps.jwtSecret,
    encryptionKey: deps.encryptionKey,
    tokenTtlSeconds: deps.tokenTtlSeconds,
  });

  // whoami
  app.get(
    '/api/v1/admin/me',
    { preHandler: requireRole(deps.jwtSecret, 'viewer') },
    async (request) => {
      const admin = request.admin!;
      return { id: admin.id, email: admin.email, role: admin.role };
    },
  );

  registerTrackingLinksRoutes(app, {
    executor: deps.executor,
    cache: deps.cache,
    idempotency: deps.idempotency,
    jwtSecret: deps.jwtSecret,
    tokenFormat: deps.tokenFormat,
    publicBaseUrl: deps.publicBaseUrl,
    botUsername: deps.botUsername,
  });

  registerPinsRoutes(app, { executor: deps.executor, jwtSecret: deps.jwtSecret });
  registerUsersRoutes(app, { executor: deps.executor, jwtSecret: deps.jwtSecret });

  // OpenAPI-схема (§39.6): публикуется из репо-файла
  app.get('/api/v1/openapi.json', async () => {
    const spec = readFileSync(new URL('../../../openapi.json', import.meta.url), 'utf8');
    return JSON.parse(spec) as unknown;
  });
}
