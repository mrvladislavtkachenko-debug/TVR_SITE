import type { FastifyInstance } from 'fastify';
import {
  AppError,
  buildDedupKey,
  classifyUaClass,
  epochMinuteOf,
  isTrackingToken,
  telegramClickPropertiesSchema,
  type TokenFormat,
} from '@tas/shared';
import { ipHash, resolveTrackingLink, recordEvents, type EventInsert } from '@tas/db/services';
import type { SqlExecutor, KvCache } from '@tas/db/services';
import type { RateCounter } from '../ratelimit.js';
import { checkRateLimit } from '../ratelimit.js';

/**
 * POST /api/v1/events — публичный приём ТОЛЬКО telegram_click (beacon с bridge,
 * Э7; харднинг M4: link_click/bridge_view пишутся сервером — публичный приём
 * всех трёх открывал воронку для pollution).
 * Best-effort: ошибки записи/резолва не ломают ответ 202.
 * Сервер обогащает событие ip_hash/ua_class и строит dedup_key сам.
 */

export interface EventsRouteDeps {
  executor: SqlExecutor;
  cache?: KvCache;
  rateCounter: RateCounter;
  ipHashSalt: string; // отдельная соль (не ENCRYPTION_KEY — ротация ключа не меняет хэши IP)
  tokenFormat: TokenFormat;
  limit?: number;
  windowSeconds?: number;
}

export function registerEventsRoute(app: FastifyInstance, deps: EventsRouteDeps): void {
  const limit = deps.limit ?? 60;
  const windowSeconds = deps.windowSeconds ?? 60;

  app.post('/api/v1/events', async (request, reply) => {
    const ip = request.ip ?? '0.0.0.0';
    const hash = ipHash(ip, deps.ipHashSalt);

    const rl = await checkRateLimit(deps.rateCounter, `tas:rl:ev:${hash}`, limit, windowSeconds);
    if (!rl.allowed) {
      reply.header('Retry-After', String(windowSeconds));
      throw new AppError('RATE_LIMITED', 'Too many requests');
    }

    const body = request.body as { name?: unknown; properties?: unknown } | undefined;
    if (body?.name === 'link_click' || body?.name === 'bridge_view') {
      // серверные события: публичный приём запрещён (харднинг M4-1)
      throw new AppError('FORBIDDEN', 'This event is recorded server-side only');
    }
    if (body?.name !== 'telegram_click') {
      throw new AppError('VALIDATION_ERROR', 'Invalid event payload', [
        { path: ['name'], message: "Expected 'telegram_click'" },
      ]);
    }
    const parsedProps = telegramClickPropertiesSchema.safeParse(body.properties);
    if (!parsedProps.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid event payload', parsedProps.error.issues);
    }
    const properties = parsedProps.data;
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
    const enriched: Record<string, unknown> = {
      ...properties,
      ua_class: classifyUaClass(Array.isArray(ua) ? ua[0] : ua),
      ip_hash: hash,
    };

    const bucketKey = properties.session_id ?? hash;
    const event: EventInsert = {
      name: 'telegram_click',
      trackingLinkId,
      properties: enriched,
      dedupKey: buildDedupKey('telegram_click', token, bucketKey, epochMinuteOf()),
    };

    try {
      await recordEvents({ executor: deps.executor }, [event]);
    } catch (err) {
      // best-effort (Э7): beacon-события не требуют гарантии записи
      request.log.warn({ err, name: 'telegram_click' }, 'events: запись не удалась (best-effort)');
    }
    reply.code(202);
    return { accepted: true };
  });
}
