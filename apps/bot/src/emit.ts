import { botEventPropsSchemas, type BotEventName } from '@tas/shared';
import { recordEvents, type SqlExecutor } from '@tas/db/services';

/**
 * Эмиттер событий бота (§16): properties валидируются per-event zod-схемой
 * ПЕРЕД записью; dedup_key = {prefix}:{event} (prefix = update_id у
 * update-источника, outbox:{id} у отправителя — §16.1/§28.10).
 */

export interface BotEventInput {
  name: BotEventName;
  userId?: string | null;
  trackingLinkId?: string | null;
  properties: Record<string, unknown>;
}

export async function emitBotEvents(
  deps: { executor: SqlExecutor },
  events: BotEventInput[],
  dedupPrefix: string,
): Promise<void> {
  if (events.length === 0) return;
  for (const e of events) {
    const schema = botEventPropsSchemas[e.name];
    const parsed = schema.safeParse(e.properties);
    if (!parsed.success) {
      throw new Error(`event ${e.name}: invalid properties: ${JSON.stringify(parsed.error.issues)}`);
    }
  }
  await recordEvents(
    { executor: deps.executor },
    events.map((e) => ({
      name: e.name,
      userId: e.userId ?? null,
      trackingLinkId: e.trackingLinkId ?? null,
      properties: e.properties,
      dedupKey: `${dedupPrefix}:${e.name}`,
    })),
  );
}
