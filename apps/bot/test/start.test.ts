import { describe, expect, it } from 'vitest';
import { makeHarness, runUpdate, startUpdate, textUpdate } from './helpers/harness.js';

/**
 * /start (§11.1, §11.2, Э1, Э4, §28.1/28.2/28.7): резолв payload ДО реакции,
 * first_touch ровно один раз, last_touch с is_current, fallback direct/unknown.
 */

describe('/start', () => {
  it('новый пользователь с валидным token: атрибуция first+last, события, лид-магнит ДО опроса', async () => {
    const h = makeHarness();
    const link = h.db.seedTrackingLink('t1aB9xK2mQz7');
    await runUpdate(h.bot, startUpdate(1001, 555, 't1aB9xK2mQz7'));

    const user = h.db.userByTelegram('555');
    expect(user).toBeDefined();
    const profile = h.db.profiles.get(user!.id);
    expect(profile?.lifecycle_state).toBe('new');
    expect(profile?.fsm_state?.node).toBe('await_segment');

    // Э1: ровно один first, ровно один текущий last
    const firsts = h.db.attributions.filter((a) => a.user_id === user!.id && a.touch === 'first');
    const lasts = h.db.attributions.filter((a) => a.user_id === user!.id && a.touch === 'last');
    expect(firsts).toHaveLength(1);
    expect(firsts[0]!.tracking_link_id).toBe(link.id);
    expect(firsts[0]!.is_current).toBe(false);
    expect(lasts).toHaveLength(1);
    expect(lasts[0]!.is_current).toBe(true);

    const start = h.db.eventsByName('telegram_start');
    expect(start).toHaveLength(1);
    expect(start[0]!.properties).toEqual({
      start_payload: 't1aB9xK2mQz7',
      payload_status: 'ok',
      is_returning: false,
      source_hint: 'tracked',
    });
    expect(start[0]!.dedup_key).toBe('u1001:telegram_start');

    // §11.4 M1: [документ] затем [вопрос]; документ с delivery_kind=file и dedup
    const rows = h.db.outboxPending();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload.document).toMatchObject({ url: 'https://files.example.com/lm.pdf' });
    expect(rows[0]!.payload.delivery_kind).toBe('file');
    expect(rows[0]!.dedup_key).toBe(`${user!.id}:lm:onboarding`);
    expect(rows[1]!.payload.text).toContain('актуальнее');
    expect((rows[1]!.payload.buttons as { callbackData: string }[]).map((b) => b.callbackData)).toEqual([
      'q1:S1',
      'q1:S2',
      'q1:S3',
      'q1:S4',
    ]);
  });

  it('повторный /start с тем же token: атрибуция не дублируется, лид-магнит не повторяется', async () => {
    const h = makeHarness();
    h.db.seedTrackingLink('t1SameToken1');
    await runUpdate(h.bot, startUpdate(1002, 556, 't1SameToken1'));
    await runUpdate(h.bot, startUpdate(1003, 556, 't1SameToken1'));

    expect(h.db.attributions).toHaveLength(2); // first + last, без новых
    // dedupKey лид-магнита отсекает повторную постановку документа
    expect(h.db.outboxPending().filter((o) => o.payload.document).length).toBe(1);
    const starts = h.db.eventsByName('telegram_start');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.properties.is_returning).toBe(true);
  });

  it('§28.7 повторный /start с ДРУГИМ token: first заморожен, last переключён is_current', async () => {
    const h = makeHarness();
    const link1 = h.db.seedTrackingLink('t1FirstLink1');
    const link2 = h.db.seedTrackingLink('t1SecondLink');
    await runUpdate(h.bot, startUpdate(1004, 557, 't1FirstLink1'));
    await runUpdate(h.bot, startUpdate(1005, 557, 't1SecondLink'));

    const user = h.db.userByTelegram('557')!;
    const firsts = h.db.attributions.filter((a) => a.user_id === user.id && a.touch === 'first');
    expect(firsts).toHaveLength(1);
    expect(firsts[0]!.tracking_link_id).toBe(link1.id); // first не тронут (§28.1)

    const currentLast = h.db.attributions.find((a) => a.user_id === user.id && a.touch === 'last' && a.is_current);
    expect(currentLast?.tracking_link_id).toBe(link2.id);
    const oldLast = h.db.attributions.find((a) => a.user_id === user.id && a.touch === 'last' && !a.is_current);
    expect(oldLast?.tracking_link_id).toBe(link1.id);
  });

  it('§28.2 /start без payload: direct, без строк атрибуции', async () => {
    const h = makeHarness();
    await runUpdate(h.bot, startUpdate(1006, 558));
    const start = h.db.eventsByName('telegram_start')[0]!;
    expect(start.properties).toEqual({
      start_payload: null,
      payload_status: 'none',
      is_returning: false,
      source_hint: 'direct',
    });
    expect(h.db.attributions).toHaveLength(0);
  });

  it('Э4: битый payload → unknown + alert-лог, БЕЗ попыток резолва (нет Левенштейна)', async () => {
    const h = makeHarness();
    await runUpdate(h.bot, startUpdate(1007, 559, 't1BAD%$'));
    const start = h.db.eventsByName('telegram_start')[0]!;
    expect(start.properties.payload_status).toBe('malformed');
    expect(start.properties.source_hint).toBe('unknown');
    expect(h.db.attributions).toHaveLength(0);
    expect(h.log.lines.some((l) => l.msg.includes('malformed'))).toBe(true);
  });

  it('Э4: валидный формат, но неизвестный token → unresolved', async () => {
    const h = makeHarness();
    await runUpdate(h.bot, startUpdate(1008, 560, 't1Unknown999'));
    const start = h.db.eventsByName('telegram_start')[0]!;
    expect(start.properties.payload_status).toBe('unresolved');
    expect(h.db.attributions).toHaveLength(0);
  });

  it('§11.2/§28.1 завершённый онбординг: «с возвращением» + меню, без повторного онбординга', async () => {
    const h = makeHarness();
    h.db.seedTrackingLink('t1WelcomeBak');
    await runUpdate(h.bot, startUpdate(1009, 561, 't1WelcomeBak'));
    const user = h.db.userByTelegram('561')!;
    // завершаем онбординг напрямую через fake-БД
    const profile = h.db.profiles.get(user.id)!;
    profile.onboarding_completed_at = new Date();
    profile.fsm_state = null;

    await runUpdate(h.bot, startUpdate(1010, 561, 't1WelcomeBak'));
    const rows = h.db.outboxPending();
    const lastRow = rows.at(-1)!;
    expect(lastRow.template_code).toBe('bot_welcome_back');
    expect((lastRow.payload.text as string)).toContain('С возвращением');
    expect((lastRow.payload.buttons as { callbackData: string }[]).map((b) => b.callbackData)).toContain('lm:again');
    const profileAfter = h.db.profiles.get(user.id)!;
    expect(profileAfter.fsm_state).toBeNull();
    expect(h.db.eventsByName('telegram_start')[1]!.properties.is_returning).toBe(true);
  });

  it('§28.5/§11.5 заблокированный пользователь вернулся: is_blocked снят, blocked → reactivated', async () => {
    const h = makeHarness();
    h.db.seedTrackingLink('t1Unblock123');
    await runUpdate(h.bot, startUpdate(1011, 562, 't1Unblock123'));
    const user = h.db.userByTelegram('562')!;
    user.is_blocked = true;
    user.blocked_at = new Date();
    h.db.profiles.get(user.id)!.lifecycle_state = 'blocked';

    await runUpdate(h.bot, startUpdate(1012, 562, 't1Unblock123'));
    expect(user.is_blocked).toBe(false);
    expect(h.db.profiles.get(user.id)!.lifecycle_state).toBe('reactivated');
    const changed = h.db.eventsByName('user_state_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.properties).toEqual({ from: 'blocked', to: 'reactivated' });
  });

  it('§16.3 privacy: содержимое переписки не попадает в логи', async () => {
    const h = makeHarness();
    await runUpdate(h.bot, startUpdate(1013, 563, 't1Unknown888'));
    await runUpdate(h.bot, textUpdate(1014, 563, 'SENSITIVE-SECRET-TEXT-123'));
    const dump = h.log.dump();
    expect(dump).not.toContain('SENSITIVE-SECRET-TEXT-123');
    // и не в свойствах message_received — только корзина длины
    const mr = h.db.eventsByName('message_received')[0]!;
    expect(mr.properties.length_bucket).toBe('short');
    expect(JSON.stringify(mr.properties)).not.toContain('SENSITIVE');
  });
});
