/**
 * FSM онбординга (§11.4, §11.6). Состояние — user_profiles.fsm_state
 * {node, context}. Диаграмма фактическая — в отчёте M5 / CHANGELOG.
 *
 *   idle ──/start (онбординг не завершён)──► await_segment
 *   await_segment ──callback q1:S1..S4──► await_frequency
 *   await_frequency ──callback q2:normal|q2:low──► idle (onboarding_completed)
 *   await_* ──произвольный текст──► подсказка ×2, затем игнор (§28.16)
 *   /stop в любом состоянии ──► idle (цепочки погашены)
 */

export type FsmNode = 'idle' | 'await_segment' | 'await_frequency';

export interface FsmState {
  node: FsmNode;
  context: { hints: number };
}

export function fsmState(node: FsmNode, hints = 0): FsmState {
  return { node, context: { hints } };
}

export const ONBOARDING_SEGMENT_CODES = ['S1', 'S2', 'S3', 'S4'] as const;
export type OnboardingSegmentCode = (typeof ONBOARDING_SEGMENT_CODES)[number];

export const FREQUENCY_CALLBACKS = { normal: 'q2:normal', low: 'q2:low' } as const;
export type FrequencyValue = keyof typeof FREQUENCY_CALLBACKS;

export function isOnboardingNode(node: string | undefined | null): boolean {
  return node === 'await_segment' || node === 'await_frequency';
}

/** callback_data-префиксы роутера кнопок (все ≤64 байт, §39.7). */
export const CALLBACK = {
  segment: 'q1:',
  frequency: 'q2:',
  leadMagnetAgain: 'lm:again',
  plan: 'plan:show',
  products: 'products:list',
  feedbackAsk: 'feedback:ask',
  feedbackGood: 'fb:good',
  feedbackBad: 'fb:bad',
  settingsOpen: 'settings:open',
  setFrequencyNormal: 'setfreq:normal',
  setFrequencyLow: 'setfreq:low',
} as const;

/** Максимальное число подсказок «выберите кнопку» (§28.16). */
export const FSM_HINT_LIMIT = 2;
