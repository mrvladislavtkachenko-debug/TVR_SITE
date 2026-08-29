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

// ---------------------------------------------------------------------------
// Per-event схемы properties (§16.2). M3: bridge-события; M5: события бота.
// ---------------------------------------------------------------------------

/** Корзины длины текста вместо самой длины (privacy §16.3 — не логируем текст). */
export const MESSAGE_LENGTH_BUCKETS = ['empty', 'short', 'medium', 'long'] as const;
export type MessageLengthBucket = (typeof MESSAGE_LENGTH_BUCKETS)[number];

export function messageLengthBucket(length: number): MessageLengthBucket {
  if (length <= 0) return 'empty';
  if (length <= 64) return 'short';
  if (length <= 256) return 'medium';
  return 'long';
}

/** telegram_start: источник входа в бота (§16.2, Э4 — без Левенштейна). */
export const telegramStartPropsSchema = z.object({
  start_payload: z.string().max(64).nullable(),
  /** ok — резолвнут; none — /start без payload; malformed — запрещённые символы; unresolved — токен не найден. */
  payload_status: z.enum(['ok', 'none', 'malformed', 'unresolved']),
  is_returning: z.boolean(),
  source_hint: z.enum(['tracked', 'direct', 'telegram_organic', 'unknown']),
});

export const onboardingStartedPropsSchema = z.object({ step: z.number().int().min(1) });

export const onboardingCompletedPropsSchema = z.object({ segment_code: z.string().min(1).max(64) });

export const leadMagnetDeliveredPropsSchema = z.object({
  delivery_kind: z.enum(['file', 'link']),
});

export const segmentAssignedPropsSchema = z.object({
  segment_code: z.string().min(1).max(64),
  origin: z.enum(['onboarding', 'rule', 'manual']),
});

export const buttonClickedPropsSchema = z.object({
  button_code: z.string().min(1).max(64),
  screen: z.string().min(1).max(64),
});

export const menuOpenedPropsSchema = z.object({}).strict();

export const messageReceivedPropsSchema = z.object({
  length_bucket: z.enum(MESSAGE_LENGTH_BUCKETS),
  /** intent_class появится в M9 (AI-классификация); в M5 намеренно отсутствует. */
});

export const settingsChangedPropsSchema = z.object({
  field: z.string().min(1).max(64),
  value: z.string().min(1).max(64),
});

export const unsubscribePropsSchema = z.object({
  reason: z.string().max(128).nullable(),
});

export const botBlockedPropsSchema = z.object({
  last_flow_code: z.string().max(64).nullable(),
});

export const userStateChangedPropsSchema = z.object({
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
});

export const userActivatedPropsSchema = z.object({ days_since_start: z.number().int().min(0) });

export const reengagedPropsSchema = z.object({ days_silent: z.number().int().min(0) });

export const automationMessageSentPropsSchema = z.object({
  flow_code: z.string().min(1).max(64),
  step: z.number().int().min(0),
  template_code: z.string().min(1).max(64),
});

export const contentViewedPropsSchema = z.object({
  content_code: z.string().min(1).max(64),
  position: z.number().int().min(0).optional(),
});

export const productViewedPropsSchema = z.object({ product_code: z.string().min(1).max(64) });

export const checkoutOpenedPropsSchema = z.object({
  product_code: z.string().min(1).max(64),
  stars_amount: z.number().int().min(1),
});

export const purchaseCompletedPropsSchema = z.object({
  order_id: z.string().min(1).max(64),
  product_code: z.string().min(1).max(64),
  stars_amount: z.number().int().min(1),
  usd_equiv: z.number().min(0),
});

export const leadCreatedPropsSchema = z.object({ email_hash: z.string().min(16).max(128) });

export const feedbackSubmittedPropsSchema = z.object({ score: z.number().int().min(0).max(1) });

export const supportRequestedPropsSchema = z.object({}).strict();

/** Реестр схем properties всех событий MVP (§16.2), эмитируемых кодом. */
export const botEventPropsSchemas = {
  telegram_start: telegramStartPropsSchema,
  onboarding_started: onboardingStartedPropsSchema,
  onboarding_completed: onboardingCompletedPropsSchema,
  lead_magnet_delivered: leadMagnetDeliveredPropsSchema,
  segment_assigned: segmentAssignedPropsSchema,
  button_clicked: buttonClickedPropsSchema,
  menu_opened: menuOpenedPropsSchema,
  message_received: messageReceivedPropsSchema,
  settings_changed: settingsChangedPropsSchema,
  unsubscribe: unsubscribePropsSchema,
  bot_blocked: botBlockedPropsSchema,
  user_state_changed: userStateChangedPropsSchema,
  user_activated: userActivatedPropsSchema,
  reengaged: reengagedPropsSchema,
  automation_message_sent: automationMessageSentPropsSchema,
  content_viewed: contentViewedPropsSchema,
  product_viewed: productViewedPropsSchema,
  checkout_opened: checkoutOpenedPropsSchema,
  purchase_completed: purchaseCompletedPropsSchema,
  lead_created: leadCreatedPropsSchema,
  feedback_submitted: feedbackSubmittedPropsSchema,
  support_requested: supportRequestedPropsSchema,
} as const;

export type BotEventName = keyof typeof botEventPropsSchemas;
