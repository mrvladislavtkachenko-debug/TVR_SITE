import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@tas/shared';
import { createPin, listPins, setPinStatus, writeAudit, type PinStatus, type SqlExecutor } from '@tas/db/services';
import { requireRole } from '../../auth/guard.js';

/**
 * Контент-очередь (PRD §18 Content Factory, MVP-подмножество):
 * GET /api/v1/admin/pins (viewer+), POST (editor+), PATCH /:id — переходы
 * статусов idea→approved→scheduled→published (paused↔published).
 */

const pinStatusSchema = z.enum(['idea', 'approved', 'scheduled', 'published', 'paused']);

const createPinSchema = z.object({
  cluster_id: z.string().regex(/^\d+$/),
  keyword_id: z.string().regex(/^\d+$/).nullish(),
  campaign_id: z.string().regex(/^\d+$/).nullish(),
  title: z.string().min(3).max(500),
  description: z.string().max(2000).nullish(),
});

export function registerPinsRoutes(app: FastifyInstance, deps: { executor: SqlExecutor; jwtSecret: string }): void {
  app.get(
    '/api/v1/admin/pins',
    { preHandler: requireRole(deps.jwtSecret, 'viewer') },
    async (request) => {
      const q = z
        .object({
          status: pinStatusSchema.optional(),
          cluster_id: z.string().regex(/^\d+$/).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query ?? {});
      const rows = await listPins(deps.executor, {
        status: q.status as PinStatus | undefined,
        clusterId: q.cluster_id,
        limit: q.limit,
      });
      return { rows, total: rows.length };
    },
  );

  app.post(
    '/api/v1/admin/pins',
    { preHandler: requireRole(deps.jwtSecret, 'editor') },
    async (request, reply) => {
      const parsed = createPinSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid payload', parsed.error.issues);
      }
      const admin = request.admin!;
      const pin = await createPin(deps.executor, admin, {
        clusterId: parsed.data.cluster_id,
        keywordId: parsed.data.keyword_id ?? null,
        campaignId: parsed.data.campaign_id ?? null,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
      });
      await writeAudit(deps.executor, {
        actorType: 'admin',
        actorId: admin.id,
        action: 'pin_created',
        entity: 'pins',
        entityId: pin.id,
        meta: { title: pin.title },
      });
      reply.code(201);
      return pin;
    },
  );

  app.patch(
    '/api/v1/admin/pins/:id',
    { preHandler: requireRole(deps.jwtSecret, 'editor') },
    async (request, reply) => {
      const params = z.object({ id: z.string().regex(/^\d+$/) }).safeParse(request.params);
      const body = z.object({ status: pinStatusSchema }).safeParse(request.body);
      if (!params.success || !body.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid payload', [
          ...(params.success ? [] : params.error.issues),
          ...(body.success ? [] : body.error.issues),
        ]);
      }
      const admin = request.admin!;
      const pin = await setPinStatus(deps.executor, admin, params.data.id, body.data.status as PinStatus);
      await writeAudit(deps.executor, {
        actorType: 'admin',
        actorId: admin.id,
        action: 'pin_status_changed',
        entity: 'pins',
        entityId: pin.id,
        meta: { status: pin.status },
      });
      reply.code(200);
      return pin;
    },
  );
}
