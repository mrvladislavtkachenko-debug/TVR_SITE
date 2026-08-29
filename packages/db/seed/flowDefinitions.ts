/**
 * Определения трёх MVP-флоу §13.2 (схема §13.1; интерпретатор — apps/worker).
 * Выделено из seed.ts для импорта в тесты без side-эффектов (M6).
 */
export interface SeedFlow {
  code: string;
  definition: Record<string, unknown>;
}

export const SEED_FLOWS: SeedFlow[] = [
  {
    code: 'welcome_series_v1',
    definition: {
      trigger: { type: 'event', event: 'onboarding_completed' },
      conditions: [],
      steps: [
        { action: 'send_message', template: 'ws_value_1', delay_hours: 24 },
        { action: 'send_message', template: 'ws_value_2', delay_hours: 48 },
        {
          action: 'send_message',
          template: 'ws_offer_planner',
          delay_hours: 72,
          buttons: [{ text: 'Get Planner Pack', type: 'stars_invoice', product: 'planner_pack' }],
        },
        {
          branch: {
            if: 'event(purchase_completed) within 72h',
            then: 'goto(post_purchase_v1)',
            else: 'goto(checkout_abandonment_v1)',
          },
        },
      ],
      guard: { cancel_if: ['user_blocked', 'unsubscribed', 'purchased_product'] },
    },
  },
  {
    code: 'checkout_abandonment_v1',
    definition: {
      trigger: { type: 'event', event: 'checkout_opened' },
      conditions: [{ expr: 'no event(purchase_completed) within 48h' }],
      steps: [
        { action: 'send_message', template: 'ca_objection_1', delay_hours: 24 },
        { action: 'send_message', template: 'ca_bonus_2', delay_hours: 72 },
      ],
      guard: { cancel_if: ['user_blocked', 'unsubscribed', 'purchased_product'] },
    },
  },
  {
    code: 'winback_v1',
    definition: {
      trigger: { type: 'state_changed', to: 'at_risk' },
      conditions: [],
      steps: [
        {
          action: 'send_message',
          template: 'wb_reengage',
          delay_hours: 0,
          buttons: [
            { text: 'Да, давай', type: 'callback', data: 'wb:yes' },
            { text: 'Отписаться', type: 'callback', data: 'wb:unsubscribe' },
          ],
        },
      ],
      // §28.6: win-back не дублируется — прогон не чаще раза в 30 дней
      guard: { cancel_if: ['user_blocked', 'unsubscribed'], repeat_days: 30 },
    },
  },
] as SeedFlow[];
