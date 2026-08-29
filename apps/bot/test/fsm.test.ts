import { describe, expect, it } from 'vitest';
import { callbackUpdate, makeHarness, runUpdate, startUpdate, textUpdate } from './helpers/harness.js';

/** Онбординг-FSM §11.4 + §28.16 (fallback-подсказки). */

async function onboardedHarness() {
  const h = makeHarness();
  await runUpdate(h.bot, startUpdate(2001, 700, undefined));
  return h;
}

describe('FSM онбординга (§11.4)', () => {
  it('клик q1:S2: сегмент назначен, onboarding_started, quick-win + вопрос о частоте', async () => {
    const h = await onboardedHarness();
    const user = h.db.userByTelegram('700')!;
    await runUpdate(h.bot, callbackUpdate(2002, 700, 'q1:S2'));

    const profile = h.db.profiles.get(user.id)!;
    expect(profile.interest_segment_id).toBe('102'); // S2
    expect(profile.fsm_state?.node).toBe('await_frequency');

    const seg = h.db.userSegments.get(`${user.id}:102`);
    expect(seg?.origin).toBe('onboarding');
    expect(seg?.removed_at).toBeNull();

    expect(h.db.eventsByName('onboarding_started')[0]!.properties).toEqual({ step: 1 });
    expect(h.db.eventsByName('segment_assigned')[0]!.properties).toEqual({
      segment_code: 'S2',
      origin: 'onboarding',
    });
    expect(h.db.eventsByName('button_clicked')[0]!.properties).toEqual({
      button_code: 'q1:S2',
      screen: 'onboarding_q1',
    });

    const last = h.db.outboxPending().at(-1)!;
    expect(last.template_code).toBe('bot_q2');
    expect(last.payload.text as string).toContain('3 шага (S2)');
    expect(last.payload.text as string).toContain('2–3 раза в неделю');
    expect((last.payload.buttons as { callbackData: string }[]).map((b) => b.callbackData)).toEqual([
      'q2:normal',
      'q2:low',
    ]);
  });

  it('клик q2:low: onboarding_completed (один раз), lifecycle new→onboarded, меню, fsm idle', async () => {
    const h = await onboardedHarness();
    const user = h.db.userByTelegram('700')!;
    await runUpdate(h.bot, callbackUpdate(2003, 700, 'q1:S1'));
    await runUpdate(h.bot, callbackUpdate(2004, 700, 'q2:low'));

    const profile = h.db.profiles.get(user.id)!;
    expect(profile.onboarding_completed_at).not.toBeNull();
    expect(profile.message_frequency).toBe('low');
    expect(profile.lifecycle_state).toBe('onboarded');
    expect(profile.fsm_state).toBeNull();

    expect(h.db.eventsByName('onboarding_completed')).toHaveLength(1);
    expect(h.db.eventsByName('onboarding_completed')[0]!.properties).toEqual({ segment_code: 'S1' });
    const changed = h.db.eventsByName('user_state_changed');
    expect(changed.some((e) => e.properties).valueOf()).toBeTruthy();
    expect(changed[0]!.properties).toEqual({ from: 'new', to: 'onboarded' });
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_menu');
  });

  it('§28.16: не-командный текст в онбординге — подсказка ×2, затем игнор; message_received каждый раз', async () => {
    const h = await onboardedHarness();
    const user = h.db.userByTelegram('700')!;
    const outboxBefore = h.db.outbox.length;
    await runUpdate(h.bot, textUpdate(2010, 700, 'не знаю что выбрать'));
    await runUpdate(h.bot, textUpdate(2011, 700, 'все ещё думаю'));
    await runUpdate(h.bot, textUpdate(2012, 700, 'хватит спрашивать'));
    // 2 подсказки поставлены, третья — нет
    const hints = h.db.outbox.filter((o) => o.template_code === 'bot_fsm_hint');
    expect(hints.length).toBe(2);
    expect(h.db.outbox.length).toBe(outboxBefore + 2);
    expect(h.db.eventsByName('message_received')).toHaveLength(3);
    // FSM остаётся в онбординге (сегмент не выбран)
    expect(h.db.profiles.get(user.id)!.fsm_state?.node).toBe('await_segment');
  });

  it('stale-кнопка q1 после завершения: сегмент НЕ меняется', async () => {
    const h = await onboardedHarness();
    const user = h.db.userByTelegram('700')!;
    await runUpdate(h.bot, callbackUpdate(2020, 700, 'q1:S1'));
    await runUpdate(h.bot, callbackUpdate(2021, 700, 'q2:normal'));
    // позже жмёт старую кнопку q1:S3
    await runUpdate(h.bot, callbackUpdate(2022, 700, 'q1:S3'));
    const profile = h.db.profiles.get(user.id)!;
    expect(profile.interest_segment_id).toBe('101'); // остался S1
    expect(profile.fsm_state).toBeNull();
    expect(h.db.eventsByName('segment_assigned')).toHaveLength(1);
    expect(h.transport.answers.at(-1)?.text).toContain('/menu');
  });

  it('stale-кнопка q2 вне онбординга: частота не меняется, вежливый answer', async () => {
    const h = await onboardedHarness();
    const user = h.db.userByTelegram('700')!;
    await runUpdate(h.bot, callbackUpdate(2030, 700, 'q1:S1'));
    await runUpdate(h.bot, callbackUpdate(2031, 700, 'q2:normal'));
    await runUpdate(h.bot, callbackUpdate(2032, 700, 'q2:low'));
    expect(h.db.profiles.get(user.id)!.message_frequency).toBe('normal');
    expect(h.db.eventsByName('onboarding_completed')).toHaveLength(1);
  });

  it('неизвестный callback: answer без действий, button_clicked screen=unknown', async () => {
    const h = await onboardedHarness();
    await runUpdate(h.bot, callbackUpdate(2040, 700, 'mystery:xyz'));
    const btn = h.db.eventsByName('button_clicked')[0]!;
    expect(btn.properties).toEqual({ button_code: 'mystery:xyz', screen: 'unknown' });
  });
});
