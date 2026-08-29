import { botEventPropsSchemas, type BotEventName } from '@tas/shared';
import { recordEvents } from './events.js';
import type { SqlExecutor } from './sql.js';

/**
 * Эмиттер событий бота/воркера (§16): properties валидируются per-event
 * zod-схемой ПЕРЕД записью. Два способа дедупа:
 *  - emitBotEvents(events, dedupPrefix) → key = `{prefix}:{event}` (update-источник);
 *  - emitSafeBotEvent(event с явным dedupKey) — отправитель (`outbox:{id}:{event}`).
 */

export interface BotEventSpec {
  name: BotEventName;
  userId?: string | null;
  trackingLinkId?: string | null;
  properties: Record<string, unknown>;
}

export interface PreciseBotEvent extends BotEventSpec {
  dedupKey: string;
}

async function writeValidated(executor: SqlExecutor, events: PreciseBotEvent[]): Promise<void> {
  if (events.length === 0) return;
  for (const e of events) {
    const schema = botEventPropsSchemas[e.name];
    const parsed = schema.safeParse(e.properties);
    if (!parsed.success) {
      throw new Error(`event ${e.name}: invalid properties: ${JSON.stringify(parsed.error.issues)}`);
    }
  }
  await recordEvents(
    { executor },
    events.map((e) => ({
      name: e.name,
      userId: e.userId ?? null,
      trackingLinkId: e.trackingLinkId ?? null,
      properties: e.properties,
      dedupKey: e.dedupKey,
    })),
  );
}

/** Батч с префиксным дедупом `{prefix}:{event}` (источник — Telegram update). */
export async function emitBotEvents(
  deps: { executor: SqlExecutor },
  events: BotEventSpec[],
  dedupPrefix: string,
): Promise<void> {
  await writeValidated(
    deps.executor,
    events.map((e) => ({ ...e, dedupKey: `${dedupPrefix}:${e.name}` })),
  );
}

/** Одно событие с явным dedupKey (отправитель: `outbox:{id}:{event}`). */
export async function emitSafeBotEvent(
  executor: SqlExecutor,
  event: PreciseBotEvent,
): Promise<void> {
  await writeValidated(executor, [event]);
}
