import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@tas/shared';
import { getUserCard, listUsers, type SqlExecutor } from '@tas/db/services';
import { requireRole } from '../../auth/guard.js';

/** GET /api/v1/admin/users, GET /api/v1/admin/users/:id — read-only (viewer+). */

const lifecycleStates = [
  'new', 'onboarded', 'activated', 'engaged', 'lead', 'customer', 'at_risk', 'churned', 'reactivated', 'blocked',
] as const;

export function registerUsersRoutes(app: FastifyInstance, deps: { executor: SqlExecutor; jwtSecret: string }): void {
  app.get(
    '/api/v1/admin/users',
    { preHandler: requireRole(deps.jwtSecret, 'viewer') },
    async (request) => {
      const q = z
        .object({
          q: z.string().max(100).optional(),
          state: z.enum(lifecycleStates).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(request.query ?? {});
      return listUsers(deps.executor, q);
    },
  );

  app.get(
    '/api/v1/admin/users/:id',
    { preHandler: requireRole(deps.jwtSecret, 'viewer') },
    async (request, reply) => {
      const params = z.object({ id: z.string().regex(/^\d+$/) }).safeParse(request.params);
      if (!params.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid params', params.error.issues);
      }
      const card = await getUserCard(deps.executor, params.data.id);
      if (!card) throw new AppError('NOT_FOUND', 'User not found');
      reply.code(200);
      return card;
    },
  );
}
