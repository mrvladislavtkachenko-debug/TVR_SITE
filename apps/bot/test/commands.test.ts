import { describe, expect, it } from 'vitest';
import {
  callbackUpdate,
  makeHarness,
  runUpdate,
  startUpdate,
  textUpdate,
} from './helpers/harness.js';

/** Команды §11.2 и кнопки меню §11.3: /menu, /help, /support, /settings, /stop. */

const TG = 800;

async function onboarded() {
  const h = makeHarness();
  await runUpdate(h.bot, startUpdate(3001, TG, undefined));
  await runUpdate(h.bot, callbackUpdate(3002, TG, 'q1:S1'));
  await runUpdate(h.bot, callbackUpdate(3003, TG, 'q2:normal'));
  return h;
}

describe('команды и меню', () => {
  it('/menu: menu_opened + inline-клавиатура разделов §11.3', async () => {
    const h = await onboarded();
    await runUpdate(h.bot, textUpdate(3004, TG, '/menu'));
    const last = h.db.outboxPending().at(-1)!;
    expect(last.template_code).toBe('bot_menu');
    const datas = (last.payload.buttons as { callbackData: string }[]).map((b) => b.callbackData);
    expect(datas).toEqual(['lm:again', 'plan:show', 'products:list', 'feedback:ask', 'settings:open']);
    expect(h.db.eventsByName('menu_opened')).toHaveLength(1);
  });

  it('/help и /support: шаблоны, support_requested', async () => {
    const h = await onboarded();
    await runUpdate(h.bot, textUpdate(3005, TG, '/help'));
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_help');
    await runUpdate(h.bot, textUpdate(3006, TG, '/support'));
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_support');
    expect(h.db.eventsByName('support_requested')).toHaveLength(1);
  });

  it('/settings → setfreq:low: settings_changed + профиль обновлён', async () => {
    const h = await onboarded();
    const user = h.db.userByTelegram(String(TG))!;
    await runUpdate(h.bot, textUpdate(3007, TG, '/settings'));
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_settings');
    await runUpdate(h.bot, callbackUpdate(3008, TG, 'setfreq:low'));
    expect(h.db.profiles.get(user.id)!.message_frequency).toBe('low');
    const ev = h.db.eventsByName('settings_changed')[0]!;
    expect(ev.properties).toEqual({ field: 'message_frequency', value: 'low' });
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_settings_done');
  });

  it('lm:again: повторная выдача лид-магнита без dedup', async () => {
    const h = await onboarded();
    const docsBefore = h.db.outbox.filter((o) => o.payload.document).length;
    await runUpdate(h.bot, callbackUpdate(3009, TG, 'lm:again'));
    const docs = h.db.outbox.filter((o) => o.payload.document);
    expect(docs.length).toBe(docsBefore + 1);
    expect(docs.at(-1)!.dedup_key).toBeNull();
    expect(docs.at(-1)!.payload.delivery_kind).toBe('file');
  });

  it('plan:show: quick-win сегмента; без сегмента — бот попросит /start', async () => {
    const h = await onboarded();
    await runUpdate(h.bot, callbackUpdate(3010, TG, 'plan:show'));
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_qw_s1');

    const h2 = makeHarness();
    await runUpdate(h2.bot, startUpdate(3011, 801, undefined));
    await runUpdate(h2.bot, callbackUpdate(3012, 801, 'plan:show'));
    // сегмент ещё не выбран: подсказка
    expect(h2.db.outboxPending().at(-1)!.template_code).toBe('bot_plan_no_segment');
  });

  it('products:list: честный MVP-ответ (каталог M7)', async () => {
    const h = await onboarded();
    await runUpdate(h.bot, callbackUpdate(3013, TG, 'products:list'));
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_products_soon');
  });

  it('feedback: fb:good → feedback_submitted{score:1}', async () => {
    const h = await onboarded();
    await runUpdate(h.bot, callbackUpdate(3014, TG, 'feedback:ask'));
    await runUpdate(h.bot, callbackUpdate(3015, TG, 'fb:good'));
    expect(h.db.eventsByName('feedback_submitted')[0]!.properties).toEqual({ score: 1 });
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_feedback_thanks');
  });

  it('/stop: unsubscribe-сегмент, гашение chains и outbox, событие, ответ', async () => {
    const h = await onboarded();
    const user = h.db.userByTelegram(String(TG))!;
    // имитируем активную цепочку и неподписанную отправку (M6-сценарий)
    h.db.flowRuns.push({ id: '1', user_id: user.id, status: 'active' });
    h.db.outbox.push({
      id: h.db.nextId('outbox'),
      user_id: user.id,
      kind: 'flow',
      template_code: 'ws_value_1',
      payload: { chat_id: String(TG), text: 'advice' },
      status: 'pending',
      telegram_message_id: null,
      scheduled_at: new Date(),
      sent_at: null,
      error: null,
      dedup_key: null,
    });

    await runUpdate(h.bot, textUpdate(3016, TG, '/stop'));

    const membership = h.db.userSegments.get(`${user.id}:105`);
    expect(membership?.removed_at).toBeNull(); // в unsubscribed
    expect(h.db.flowRuns[0]!.status).toBe('cancelled');
    expect(h.db.outbox.find((o) => o.kind === 'flow')!.status).toBe('skipped');
    expect(h.db.eventsByName('unsubscribe')[0]!.properties).toEqual({ reason: null });
    expect(h.db.outboxPending().at(-1)!.template_code).toBe('bot_stop');
    // fsm сброшен
    expect(h.db.profiles.get(user.id)!.fsm_state).toBeNull();
  });

  it('resubscribe: /start после /stop снимает unsubscribed (§11.2 «вернуться»)', async () => {
    const h = await onboarded();
    const user = h.db.userByTelegram(String(TG))!;
    await runUpdate(h.bot, textUpdate(3017, TG, '/stop'));
    await runUpdate(h.bot, startUpdate(3018, TG));
    const membership = h.db.userSegments.get(`${user.id}:105`);
    expect(membership?.removed_at).not.toBeNull();
  });
});
