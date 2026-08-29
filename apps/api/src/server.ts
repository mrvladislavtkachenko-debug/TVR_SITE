import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, errorEnvelope } from '@tas/shared';

export type ComponentState = 'up' | 'down';

export interface HealthChecks {
  db: () => Promise<ComponentState>;
  queue: () => Promise<ComponentState>;
}

export interface BuildServerOptions {
  checks: HealthChecks;
  logger?: boolean | { level: string };
  /** Регистрация дополнительных роутов (внедрение зависимостей для тестируемости). */
  routes?: (app: FastifyInstance) => void;
}

async function safe(check: () => Promise<ComponentState>): Promise<ComponentState> {
  try {
    return await check();
  } catch {
    return 'down';
  }
}

/**
 * Фабрика приложения. В тестах передаются stub-проверки (hermetic).
 * Дублируется в apps/bot — см. TECH_DEBT TD-002 (scope @tas/shared — Э5).
 */
export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? { level: 'info' } });

  app.get('/health', async (_request, reply) => {
    const [db, queue] = await Promise.all([safe(opts.checks.db), safe(opts.checks.queue)]);
    const status: 'ok' | 'degraded' = db === 'up' && queue === 'up' ? 'ok' : 'degraded';
    reply.code(status === 'ok' ? 200 : 503);
    return { status, db, queue };
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(errorEnvelope('NOT_FOUND', 'Route not found'));
  });

  opts.routes?.(app);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send(errorEnvelope(error.code, error.message, error.details));
      return;
    }
    app.log.error(error);
    reply.code(500).send(errorEnvelope('INTERNAL', 'Internal server error'));
  });

  return app;
}
