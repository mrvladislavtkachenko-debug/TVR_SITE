import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, publicTrackingUrl, telegramDeepLink, type TokenFormat } from '@tas/shared';
import {
  issueTrackingLink,
  writeAudit,
  type KvCache,
  type SqlExecutor,
} from '@tas/db/services';
import { requireRole } from '../../auth/guard.js';
import { withIdempotency, type IdempotencyStore } from '../../idempotency.js';

/**
 * POST /api/v1/admin/tracking-links — издатель ссылок для контент-пакетов
 * (editor+; PRD §19.2): генерирует token, возвращает pin-URL и tg-deep-link.
 * GET /api/v1/admin/tracking-links — последние ссылки со счётчиками воронки.
 */

const createBodySchema = z.object({
  source_id: z.string().min(1).max(32),
  landing_slug: z.string().min(1).max(96),
  pin_id: z.string().regex(/^\d+$/).nullish(),
  campaign_id: z.string().regex(/^\d+$/).nullish(),
  cluster_id: z.string().regex(/^\d+$/).nullish(),
  keyword_id: z.string().regex(/^\d+$/).nullish(),
  creative_variant: z.string().max(8).nullish(),
  landing_variant: z.string().max(8).nullish(),
  placement: z.string().max(128).nullish(),
});

export interface TrackingLinksRouteDeps {
  executor: SqlExecutor;
  cache?: KvCache;
  idempotency: IdempotencyStore;
  jwtSecret: string;
  tokenFormat: TokenFormat;
  publicBaseUrl: string;
  botUsername: string;
}

export function registerTrackingLinksRoutes(
  app: FastifyInstance,
  deps: TrackingLinksRouteDeps,
): void {
  app.post(
    '/api/v1/admin/tracking-links',
    { preHandler: requireRole(deps.jwtSecret, 'editor') },
    async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Invalid payload', parsed.error.issues);
      }
      const input = parsed.data;
      const admin = request.admin!;

      const rawKey = request.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      const result = await withIdempotency(
        deps.idempotency,
        `admin:${admin.id}`,
        idempotencyKey,
        async () => {
          const link = await issueTrackingLink(
            { executor: deps.executor, cache: deps.cache },
            {
              sourceId: input.source_id,
              pinId: input.pin_id ?? null,
              campaignId: input.campaign_id ?? null,
              clusterId: input.cluster_id ?? null,
              keywordId: input.keyword_id ?? null,
              landingSlug: input.landing_slug,
              creativeVariant: input.creative_variant ?? null,
              landingVariant: input.landing_variant ?? null,
              placement: input.placement ?? null,
            },
            deps.tokenFormat,
          );
          await writeAudit(deps.executor, {
            actorType: 'admin',
            actorId: admin.id,
            action: 'tracking_link_created',
            entity: 'tracking_links',
            entityId: link.short_code,
            meta: { pin_id: link.pin_id, landing_slug: link.landing_slug },
          });
          return {
            statusCode: 201,
            body: {
              short_code: link.short_code,
              url: publicTrackingUrl(deps.publicBaseUrl, input.landing_slug, link.short_code),
              tg_url: telegramDeepLink(deps.botUsername, link.short_code),
            },
          };
        },
      );

      if (result.replayed) reply.header('Idempotency-Replayed', 'true');
      reply.code(result.statusCode);
      return result.body;
    },
  );

  app.get(
    '/api/v1/admin/tracking-links',
    { preHandler: requireRole(deps.jwtSecret, 'viewer') },
    async (request) => {
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(
        request.query ?? {},
      );
      const result = await deps.executor.query(
        `SELECT tl.id, tl.short_code, tl.source_id, tl.pin_id, tl.cluster_id, tl.landing_slug,
                tl.creative_variant, tl.is_active, tl.created_at,
                (SELECT COUNT(*) FROM events e WHERE e.tracking_link_id = tl.id AND e.name = 'link_click')::int AS link_clicks,
                (SELECT COUNT(*) FROM events e WHERE e.tracking_link_id = tl.id AND e.name = 'telegram_start')::int AS starts
         FROM tracking_links tl ORDER BY tl.id DESC LIMIT $1`,
        [q.limit],
      );
      return { rows: result.rows, total: result.rows.length };
    },
  );
}
