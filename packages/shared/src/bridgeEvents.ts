import { z } from 'zod';

/**
 * События моста Pinterest → Telegram (PRD §16.2, Э3/Э7).
 * Воронка моста: link_click → telegram_start (telegram_start появится в M5).
 * telegram_click — вспомогательный beacon-сигнал (может теряться,
 * ретро-достраивания нет — Э7).
 */

export const uaClassSchema = z.enum(['pinterest_app', 'mobile', 'desktop', 'bot', 'other']);
export type UaClass = z.infer<typeof uaClassSchema>;

const tokenSchema = z.string().min(1).max(64);
const slugSchema = z.string().min(1).max(96);
const sessionIdSchema = z.string().min(8).max(64);
const ipHashSchema = z.string().length(64);
const hostSchema = z.string().max(255);

/** Классификация User-Agent (чистая функция; без внешних зависимостей). */
export function classifyUaClass(ua: string | undefined | null): UaClass {
  const s = (ua ?? '').trim();
  if (s === '') return 'other';
  if (/pinterest/i.test(s)) return 'pinterest_app';
  if (/(bot|crawler|spider|preview|curl|wget|python-requests|headless)/i.test(s)) return 'bot';
  if (/(mobi|android|iphone|ipad|ipod)/i.test(s)) return 'mobile';
  if (/(windows nt|macintosh|mac os x|linux|x11)/i.test(s)) return 'desktop';
  return 'other';
}

export const linkClickPropertiesSchema = z.object({
  slug: slugSchema,
  token: tokenSchema,
  referer_host: hostSchema.optional(),
  ip_hash: ipHashSchema.optional(),
  ua_class: uaClassSchema.optional(),
  session_id: sessionIdSchema.optional(),
});
export type LinkClickProperties = z.infer<typeof linkClickPropertiesSchema>;

export const bridgeViewPropertiesSchema = z.object({
  slug: slugSchema,
  token: tokenSchema,
  ua_class: uaClassSchema.optional(),
  session_id: sessionIdSchema.optional(),
});
export type BridgeViewProperties = z.infer<typeof bridgeViewPropertiesSchema>;

export const telegramClickPropertiesSchema = z.object({
  slug: slugSchema,
  token: tokenSchema,
  session_id: sessionIdSchema.optional(),
});
export type TelegramClickProperties = z.infer<typeof telegramClickPropertiesSchema>;

/** Входящее событие моста (POST /api/v1/events; телеметрию обогащает сервер). */
export const bridgeEventSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('link_click'), properties: linkClickPropertiesSchema }),
  z.object({ name: z.literal('bridge_view'), properties: bridgeViewPropertiesSchema }),
  z.object({ name: z.literal('telegram_click'), properties: telegramClickPropertiesSchema }),
]);
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;

/**
 * dedup_key (Э8): событие уникально в минутном бакете по (name, token, бакет-ключ).
 * Бакет-ключ — session_id (если есть) либо ip_hash. Максимум 128 символов.
 */
export function buildDedupKey(
  name: string,
  token: string,
  bucketKey: string,
  epochMinute: number,
): string {
  const key = `${name}:${token}:${bucketKey}:${epochMinute}`;
  if (key.length > 128) {
    throw new Error(`dedup_key превышает 128 символов (${key.length})`);
  }
  return key;
}

/** Текущая минута (epoch, UTC) для minute-bucket дедупликации. */
export function epochMinuteOf(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 60_000);
}
