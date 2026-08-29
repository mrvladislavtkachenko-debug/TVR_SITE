import type { FastifyInstance } from 'fastify';
import {
  AppError,
  bridgeEventSchema,
  buildDedupKey,
  classifyUaClass,
  epochMinuteOf,
  isTrackingToken,
  type TokenFormat,
} from '@tas/shared';
import { ipHash, resolveTrackingLink, recordEvents, type EventInsert } from '@tas/db';
import type { SqlExecutor } from '@tas/db';
import type { KvCache } from '@tas/db';
import type { RateCounter } from '../ratelimit.js';
import { checkRateLimit } from '../ratelimit.js';

/**
 * POST /api/v1/events — приём событий моста (PRD §19.1).
 * Telegram_click приходит beacon'ом с bridge-страницы (может теряться — Э7,
 * best-effort: ошибки записи не ломают ответ 202).
 * Сервер обогащает событие ip_hash/ua_class/referer_host и строит dedup_key сам.
 */

export interface EventsRouteDeps {
  executor: SqlExecutor;
  cache?: KvCache;
  rateCounter: RateCounter;
  salt: string; // для ipHash (ENCRYPTION_KEY)
  tokenFormat: TokenFormat;
  limit?: number;
  windowSeconds?: number;
}

export function registerEventsRoute(app: FastifyInstance, deps: EventsRouteDeps): void {
  const limit = deps.limit ?? 60;
  const windowSeconds = deps.windowSeconds ?? 60;

  app.post('/api/v1/events', async (request, reply) => {
    const ip = request.ip ?? '0.0.0.0';
    const hash = ipHash(ip, deps.salt);

    const rl = await checkRateLimit(deps.rateCounter, `tas:rl:ev:${hash}`, limit, windowSeconds);
    if (!rl.allowed) {
      reply.header('Retry-After', String(windowSeconds));
      throw new AppError('RATE_LIMITED', 'Too many requests');
    }

    const parsed = bridgeEventSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid event payload', parsed.error.issues);
    }
    const { name, properties } = parsed.data;
    const token = properties.token;

    // Резолв для tracking_link_id — best-effort (Э7): при недоступности БД/кэша
    // событие пишется с tracking_link_id = null, а не падает.
    let trackingLinkId: string | null = null;
    if (isTrackingToken(token, deps.tokenFormat)) {
      try {
        const link = await resolveTrackingLink(
          { executor: deps.executor, cache: deps.cache },
          token,
          deps.tokenFormat,
        );
        trackingLinkId = link?.id ?? null;
      } catch (err) {
        request.log.warn({ err, token }, 'events: resolve не удался (best-effort → null)');
      }
    }

    const ua = request.headers['user-agent'];
    const referer = request.headers.referer;
    const enriched: Record<string, unknown> = {
      ...properties,
      ua_class: classifyUaClass(Array.isArray(ua) ? ua[0] : ua),
      ip_hash: hash,
    };
    if (name === 'link_click' && referer) {
      try {
        enriched.referer_host = new URL(Array.isArray(referer) ? referer[0] : referer).hostname;
      } catch {
        // битый referer — не добавляем
      }
    }

    const bucketKey = properties.session_id ?? hash;
    const event: EventInsert = {
      name,
      trackingLinkId,
      properties: enriched,
      dedupKey: buildDedupKey(name, token, bucketKey, epochMinuteOf()),
    };

    try {
      await recordEvents({ executor: deps.executor }, [event]);
    } catch (err) {
      // best-effort (Э7): beacon-события не требуют гарантии записи
      request.log.warn({ err, name }, 'events: запись не удалась (best-effort)');
    }
    reply.code(202);
    return { accepted: true };
  });
}
