import { z } from 'zod';

/**
 * Таксономия событий (PRD §16.2). Полный набор имён MVP.
 * Per-event zod-схемы properties добавляются в M3+ по мере реализации
 * отправителей; здесь — реестр имён и базовый каркас события.
 */
export const EVENT_NAMES = [
  // Мост Pinterest → Telegram (Э7: воронка = link_click → telegram_start)
  'link_click',
  'bridge_view',
  'telegram_click', // вспомогательный beacon; может теряться, не достраивается ретро
  // Telegram-жизнь пользователя
  'telegram_start',
  'onboarding_started',
  'onboarding_completed',
  'lead_magnet_delivered',
  'content_viewed',
  'button_clicked',
  'menu_opened',
  'message_received',
  'segment_assigned',
  'automation_message_sent',
  'product_viewed',
  'checkout_opened',
  'purchase_completed',
  'lead_created',
  'feedback_submitted',
  'support_requested',
  'settings_changed',
  'unsubscribe',
  'bot_blocked',
  // Системные lifecycle-события
  'user_activated',
  'user_state_changed',
  'reengaged',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const eventNamesSet: ReadonlySet<string> = new Set(EVENT_NAMES);

export function isEventName(value: string): value is EventName {
  return eventNamesSet.has(value);
}

/** Базовый каркас события (§16.1). properties уточняются per-event в M3+. */
export const baseEventSchema = z.object({
  name: z.enum(EVENT_NAMES),
  user_id: z.number().int().positive().nullish(),
  tracking_link_id: z.number().int().positive().nullish(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  properties: z.record(z.unknown()).default({}),
  /** Идемпотентность (Э8): insert с ON CONFLICT (dedup_key) DO NOTHING. */
  dedup_key: z.string().min(1).max(128).optional(),
});

export type BaseEvent = z.infer<typeof baseEventSchema>;
