import type { Bot, Context } from 'grammy';
import type { TokenFormat } from '@tas/shared';
import { messageLengthBucket } from '@tas/shared';
import type { KvCache } from '@tas/db/services';
import {
  addSegmentMembership,
  cancelActiveFlowRuns,
  completeOnboarding,
  ensureProfile,
  enqueueOutbox,
  getBotUserState,
  getSegmentByCode,
  recordStartTouch,
  removeSegmentMembership,
  resolveTrackingLink,
  setFsmState,
  setInterestSegment,
  setLifecycleState,
  setMessageFrequency,
  skipOutboxForUser,
  unblockUserIfBlocked,
  upsertTelegramUser,
  type OutboxKind,
  type SqlExecutor,
} from '@tas/db/services';
import { emitBotEvents, type BotEventInput } from './emit.js';
import {
  CALLBACK,
  FSM_HINT_LIMIT,
  FREQUENCY_CALLBACKS,
  ONBOARDING_SEGMENT_CODES,
  fsmState,
  isOnboardingNode,
} from './fsm.js';
import type { BotLogger } from './pipeline.js';
import { renderTemplate, type TemplateStore } from './templates.js';
import type { TelegramTransport, TgButton } from './telegram.js';

/**
 * Обработчики update (§11): команды, callback-роутер, текстовый fallback.
 * Исходящие СООБЩЕНИЯ — только через outbox (§11.1); напрямую — лишь
 * answerCallbackQuery (эфемерный UI-ack, не сообщение).
 * Privacy §16.3: содержимое переписки не логируется — только id и статусы.
 */

export interface BotDeps {
  executor: SqlExecutor;
  /** Кэш резолва tracking_links (60s pos+neg, M3) — опционален в тестах. */
  cache?: KvCache;
  templates: TemplateStore;
  transport: TelegramTransport;
  leadMagnet: { url: string; filename: string };
  tokenFormat: TokenFormat;
  log: BotLogger;
}

/** Payload /start по ограничениям Telegram: ≤64, A-Za-z0-9_- (§10.1, §24.2). */
const START_PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface SendDraft {
  kind: OutboxKind;
  templateCode: string | null;
  text?: string;
  buttons?: TgButton[] | null;
  document?: { url: string; filename: string; caption?: string };
  deliveryKind?: 'file' | 'link';
  dedupKey?: string;
}

async function templateDraft(
  deps: BotDeps,
  code: string,
  kind: OutboxKind,
  vars: Record<string, string> = {},
): Promise<SendDraft | null> {
  const tpl = await deps.templates.get(code);
  if (!tpl) {
    deps.log.error({ template: code }, 'template missing in message_templates');
    return null;
  }
  return { kind, templateCode: code, text: renderTemplate(tpl.body, vars), buttons: tpl.buttons };
}

async function enqueue(
  deps: BotDeps,
  userId: string,
  chatId: string,
  drafts: SendDraft[],
): Promise<number> {
  if (drafts.length === 0) return 0;
  return enqueueOutbox(
    deps.executor,
    drafts.map((d) => ({
      userId,
      kind: d.kind,
      templateCode: d.templateCode,
      dedupKey: d.dedupKey ?? null,
      payload: {
        chat_id: chatId,
        ...(d.text !== undefined ? { text: d.text } : {}),
        ...(d.buttons ? { buttons: d.buttons } : {}),
        ...(d.document ? { document: d.document } : {}),
        ...(d.deliveryKind ? { delivery_kind: d.deliveryKind } : {}),
      },
    })),
  );
}

/**
 * Upsert пользователя + профиль + разблокировка (§28.4/28.5).
 * Возвращает userId и факт создания (для is_returning).
 */
async function ensureUser(
  deps: BotDeps,
  from: { id: number; username?: string; first_name?: string; language_code?: string },
  updateId: number,
): Promise<{ userId: string; inserted: boolean }> {
  const { id, inserted } = await upsertTelegramUser(deps.executor, {
    telegramId: String(from.id),
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    locale: from.language_code ?? null,
  });
  await ensureProfile(deps.executor, id);
  const prevLifecycle = await unblockUserIfBlocked(deps.executor, id);
  if (prevLifecycle) {
    await emitBotEvents(
      { executor: deps.executor },
      [
        {
          name: 'user_state_changed',
          userId: id,
          properties: { from: prevLifecycle, to: 'reactivated' },
        },
      ],
      `u${updateId}`,
    );
  }
  return { userId: id, inserted };
}

function screenFor(data: string): string {
  if (data.startsWith(CALLBACK.segment)) return 'onboarding_q1';
  if (data.startsWith(CALLBACK.frequency)) return 'onboarding_q2';
  if (data.startsWith(CALLBACK.setFrequencyNormal) || data.startsWith(CALLBACK.setFrequencyLow))
    return 'settings';
  if (data.startsWith(CALLBACK.settingsOpen)) return 'settings';
  if (data.startsWith(CALLBACK.leadMagnetAgain)) return 'menu';
  if (data.startsWith(CALLBACK.plan)) return 'menu';
  if (data.startsWith(CALLBACK.products)) return 'menu';
  if (data.startsWith(CALLBACK.feedbackAsk)) return 'menu';
  if (data.startsWith(CALLBACK.feedbackGood) || data.startsWith(CALLBACK.feedbackBad))
    return 'menu';
  return 'unknown';
}

function frequencyLabel(value: 'normal' | 'low'): string {
  return value === 'normal' ? 'нормальная (2–3 совета в неделю)' : 'реже (1 совет в неделю)';
}

export function registerBotHandlers(bot: Bot, deps: BotDeps): void {
  const { executor, log } = deps;

  bot.catch((err) => {
    // §16.3: без текста сообщения — только идентификаторы
    log.error({ update_id: err.ctx?.update?.update_id }, 'bot handler error');
    log.error({ err: String(err.error).slice(0, 300) }, 'bot handler error detail');
  });

  // ------------------------------------------------------------------ /start
  bot.command('start', async (ctx: Context) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const chatId = String(chat.id);
    const updateId = ctx.update.update_id;
    const { userId, inserted } = await ensureUser(deps, from, updateId);

    // РЕЗОЛВ PAYLOAD ДО ЛЮБОЙ РЕАКЦИИ (§11.1): атрибуция не теряется
    const raw = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    let payloadStatus: 'ok' | 'none' | 'malformed' | 'unresolved';
    let sourceHint: 'tracked' | 'direct' | 'telegram_organic' | 'unknown';
    let trackingLinkId: string | null = null;
    if (raw === '') {
      // §28.2: из поиска TG / шэринга
      payloadStatus = 'none';
      sourceHint = 'direct';
    } else if (!START_PAYLOAD_RE.test(raw)) {
      // Э4: битый payload → unknown + alert-лог; БЕЗ Левенштейна
      payloadStatus = 'malformed';
      sourceHint = 'unknown';
      log.warn({ update_id: updateId, user_id: userId }, 'start payload malformed (Э4)');
    } else {
      const link = await resolveTrackingLink(
        { executor: deps.executor, cache: deps.cache },
        raw,
        deps.tokenFormat,
      );
      if (link) {
        payloadStatus = 'ok';
        sourceHint = 'tracked';
        trackingLinkId = link.id;
      } else {
        payloadStatus = 'unresolved';
        sourceHint = 'unknown';
        log.warn({ update_id: updateId, user_id: userId }, 'start payload unresolved (Э4)');
      }
    }
    if (trackingLinkId) {
      await recordStartTouch({ executor: deps.executor }, { userId, trackingLinkId });
    }

    // resubscribe (§11.2): повторный /start снимает отписку
    const unsubscribed = await getSegmentByCode(executor, 'unsubscribed');
    if (unsubscribed) {
      await removeSegmentMembership(executor, userId, unsubscribed.id);
    }

    const state = await getBotUserState(executor, userId);
    const events: BotEventInput[] = [
      {
        name: 'telegram_start',
        userId,
        trackingLinkId,
        properties: {
          start_payload: raw === '' ? null : raw.slice(0, 64),
          payload_status: payloadStatus,
          is_returning: !inserted,
          source_hint: sourceHint,
        },
      },
    ];
    if (state?.lifecycle_state === 'churned') {
      const prev = await setLifecycleState(executor, userId, 'reactivated');
      if (prev) events.push({ name: 'user_state_changed', userId, properties: { from: prev, to: 'reactivated' } });
    }

    const onboarded = state?.onboarding_completed_at != null;
    if (!onboarded) {
      // §11.4 M1: лид-магнит ДО опроса + 1 вопрос 3–4 кнопками
      const welcome = await deps.templates.get('bot_welcome_doc');
      const q1 = await deps.templates.get('bot_q1');
      const drafts: SendDraft[] = [
        {
          kind: 'transactional',
          templateCode: 'bot_welcome_doc',
          document: {
            url: deps.leadMagnet.url,
            filename: deps.leadMagnet.filename,
            caption: welcome ? renderTemplate(welcome.body, { first_name: from.first_name ?? '' }) : undefined,
          },
          deliveryKind: 'file',
          dedupKey: `${userId}:lm:onboarding`,
        },
      ];
      if (q1) {
        drafts.push({ kind: 'transactional', templateCode: 'bot_q1', text: q1.body, buttons: q1.buttons });
      } else {
        log.error({ template: 'bot_q1' }, 'template missing in message_templates');
      }
      await enqueue(deps, userId, chatId, drafts);
      await setFsmState(executor, userId, fsmState('await_segment'));
    } else {
      // §11.2/§28.1: существующий с завершённым онбордингом — «с возвращением» + меню
      const wb = await templateDraft(deps, 'bot_welcome_back', 'transactional', {
        first_name: from.first_name ?? '',
      });
      if (wb) await enqueue(deps, userId, chatId, [wb]);
      await setFsmState(executor, userId, null);
    }
    await emitBotEvents({ executor: deps.executor }, events, `u${updateId}`);
  });

  // ------------------------------------------------------- команды-разделы
  bot.command('menu', async (ctx: Context) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const chatId = String(chat.id);
    const updateId = ctx.update.update_id;
    const { userId } = await ensureUser(deps, from, updateId);
    const draft = await templateDraft(deps, 'bot_menu', 'transactional');
    if (draft) await enqueue(deps, userId, chatId, [draft]);
    await emitBotEvents(
      { executor },
      [{ name: 'menu_opened', userId, properties: {} }],
      `u${updateId}`,
    );
  });

  bot.command('help', async (ctx: Context) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const { userId } = await ensureUser(deps, from, ctx.update.update_id);
    const draft = await templateDraft(deps, 'bot_help', 'transactional');
    if (draft) await enqueue(deps, userId, String(chat.id), [draft]);
  });

  bot.command('support', async (ctx: Context) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const updateId = ctx.update.update_id;
    const { userId } = await ensureUser(deps, from, updateId);
    const draft = await templateDraft(deps, 'bot_support', 'transactional');
    if (draft) await enqueue(deps, userId, String(chat.id), [draft]);
    await emitBotEvents(
      { executor },
      [{ name: 'support_requested', userId, properties: {} }],
      `u${updateId}`,
    );
  });

  bot.command('settings', async (ctx: Context) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const { userId } = await ensureUser(deps, from, ctx.update.update_id);
    const draft = await templateDraft(deps, 'bot_settings', 'transactional');
    if (draft) await enqueue(deps, userId, String(chat.id), [draft]);
  });

  // §11.2 /stop: отключить все автоматические цепочки (анти-спам репутация)
  bot.command('stop', async (ctx: Context) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return;
    const chatId = String(chat.id);
    const updateId = ctx.update.update_id;
    const { userId } = await ensureUser(deps, from, updateId);
    const seg = await getSegmentByCode(executor, 'unsubscribed');
    if (seg) {
      await addSegmentMembership(executor, { userId, segmentId: seg.id, origin: 'manual' });
    } else {
      log.error({ segment: 'unsubscribed' }, 'segment missing in seed');
    }
    const runs = await cancelActiveFlowRuns(executor, userId);
    const skipped = await skipOutboxForUser(executor, userId);
    await setFsmState(executor, userId, null);
    const draft = await templateDraft(deps, 'bot_stop', 'transactional');
    if (draft) await enqueue(deps, userId, chatId, [draft]);
    await emitBotEvents(
      { executor },
      [{ name: 'unsubscribe', userId, properties: { reason: null } }],
      `u${updateId}`,
    );
    log.info({ user_id: userId, cancelled_runs: runs, skipped_outbox: skipped }, '/stop processed');
  });

  // ------------------------------------------------------- callback-роутер
  bot.on('callback_query:data', async (ctx: Context) => {
    const cb = ctx.callbackQuery;
    if (!cb) return;
    const from = cb.from;
    const data = cb.data;
    if (typeof data !== 'string' || data.length === 0) return;
    const updateId = ctx.update.update_id;
    const chatId = String(cb.message?.chat.id ?? from.id);
    const { userId } = await ensureUser(deps, from, updateId);
    const state = await getBotUserState(executor, userId);
    const events: BotEventInput[] = [
      { name: 'button_clicked', userId, properties: { button_code: data.slice(0, 64), screen: screenFor(data) } },
    ];
    // Эфемерный UI-ack — единственный прямой вызов (не сообщение outbox)
    const answer = (text?: string): void => {
      deps.transport.answerCallbackQuery(cb.id, text).catch(() => undefined);
    };

    if (data.startsWith(CALLBACK.segment)) {
      const code = data.slice(CALLBACK.segment.length);
      if (
        state?.fsm_state?.node === 'await_segment' &&
        (ONBOARDING_SEGMENT_CODES as readonly string[]).includes(code)
      ) {
        const seg = await getSegmentByCode(executor, code);
        if (seg) {
          await setInterestSegment(executor, userId, seg.id);
          await setFsmState(executor, userId, fsmState('await_frequency'));
          events.push({ name: 'onboarding_started', userId, properties: { step: 1 } });
          events.push({ name: 'segment_assigned', userId, properties: { segment_code: code, origin: 'onboarding' } });
          // §11.4 M2: quick-win сегмента + вопрос о частоте в одном сообщении
          const qw = await deps.templates.get(`bot_qw_${code.toLowerCase()}`);
          const q2 = await deps.templates.get('bot_q2');
          if (qw || q2) {
            const body = [qw?.body, q2?.body].filter(Boolean).join('\n\n');
            await enqueue(deps, userId, chatId, [
              { kind: 'transactional', templateCode: 'bot_q2', text: body, buttons: q2?.buttons ?? null },
            ]);
          }
          answer();
        } else {
          log.error({ segment: code }, 'segment missing in seed');
          answer();
        }
      } else {
        // stale-кнопка: онбординг уже пройден/чужой шаг — сегмент не меняем
        answer('Онбординг уже завершён — главное меню: /menu');
      }
    } else if (
      data === FREQUENCY_CALLBACKS.normal ||
      data === FREQUENCY_CALLBACKS.low
    ) {
      const value = data === FREQUENCY_CALLBACKS.normal ? 'normal' : 'low';
      if (state?.fsm_state?.node === 'await_frequency') {
        await setMessageFrequency(executor, userId, value);
        const firstCompletion = await completeOnboarding(executor, userId);
        const prevLifecycle = await setLifecycleState(executor, userId, 'onboarded');
        await setFsmState(executor, userId, null);
        if (firstCompletion) {
          events.push({
            name: 'onboarding_completed',
            userId,
            properties: { segment_code: state.interest_segment_code ?? 'unknown' },
          });
        }
        if (prevLifecycle) {
          events.push({
            name: 'user_state_changed',
            userId,
            properties: { from: prevLifecycle, to: 'onboarded' },
          });
        }
        const draft = await templateDraft(deps, 'bot_menu', 'transactional');
        if (draft) await enqueue(deps, userId, chatId, [draft]);
        answer('Готово ✅');
      } else {
        answer('Этот шаг уже пройден — /menu');
      }
    } else if (data === CALLBACK.leadMagnetAgain) {
      const again = await deps.templates.get('bot_lm_again');
      await enqueue(deps, userId, chatId, [
        {
          kind: 'transactional',
          templateCode: 'bot_lm_again',
          document: {
            url: deps.leadMagnet.url,
            filename: deps.leadMagnet.filename,
            caption: again?.body,
          },
          deliveryKind: 'file',
        },
      ]);
      answer('Отправляю 📄');
    } else if (data === CALLBACK.plan) {
      const code = state?.interest_segment_code ?? null;
      const draft = code
        ? await templateDraft(deps, `bot_qw_${code.toLowerCase()}`, 'transactional')
        : await templateDraft(deps, 'bot_plan_no_segment', 'transactional');
      if (draft) await enqueue(deps, userId, chatId, [draft]);
      answer();
    } else if (data === CALLBACK.products) {
      const draft = await templateDraft(deps, 'bot_products_soon', 'transactional');
      if (draft) await enqueue(deps, userId, chatId, [draft]);
      answer();
    } else if (data === CALLBACK.feedbackAsk) {
      const draft = await templateDraft(deps, 'bot_feedback', 'transactional');
      if (draft) await enqueue(deps, userId, chatId, [draft]);
      answer();
    } else if (data === CALLBACK.feedbackGood || data === CALLBACK.feedbackBad) {
      events.push({
        name: 'feedback_submitted',
        userId,
        properties: { score: data === CALLBACK.feedbackGood ? 1 : 0 },
      });
      const draft = await templateDraft(deps, 'bot_feedback_thanks', 'transactional');
      if (draft) await enqueue(deps, userId, chatId, [draft]);
      answer('Спасибо!');
    } else if (data === CALLBACK.settingsOpen) {
      const draft = await templateDraft(deps, 'bot_settings', 'transactional');
      if (draft) await enqueue(deps, userId, chatId, [draft]);
      answer();
    } else if (data === CALLBACK.setFrequencyNormal || data === CALLBACK.setFrequencyLow) {
      const value: 'normal' | 'low' = data === CALLBACK.setFrequencyNormal ? 'normal' : 'low';
      await setMessageFrequency(executor, userId, value);
      events.push({
        name: 'settings_changed',
        userId,
        properties: { field: 'message_frequency', value },
      });
      const draft = await templateDraft(deps, 'bot_settings_done', 'transactional', {
        frequency: frequencyLabel(value),
      });
      if (draft) await enqueue(deps, userId, chatId, [draft]);
      answer('Сохранено ✅');
    } else {
      answer();
    }
    await emitBotEvents({ executor }, events, `u${updateId}`);
  });

  // ------------------------------------- не-командный текст (§28.16, §16.2)
  bot.on('message:text', async (ctx: Context) => {
    const msg = ctx.message;
    const from = ctx.from;
    if (!msg || !from) return;
    const text = msg.text ?? '';
    if (text.startsWith('/')) return; // неизвестная команда — не сообщение
    const chat = ctx.chat;
    if (!chat) return;
    const updateId = ctx.update.update_id;
    const { userId } = await ensureUser(deps, from, updateId);
    const state = await getBotUserState(executor, userId);
    const node = state?.fsm_state?.node;
    await emitBotEvents(
      { executor },
      [
        {
          name: 'message_received',
          userId,
          properties: { length_bucket: messageLengthBucket(text.length) },
        },
      ],
      `u${updateId}`,
    );
    if (isOnboardingNode(node)) {
      const hints = Number(state?.fsm_state?.context?.hints ?? 0);
      if (hints < FSM_HINT_LIMIT) {
        const draft = await templateDraft(deps, 'bot_fsm_hint', 'transactional');
        if (draft) await enqueue(deps, userId, String(chat.id), [draft]);
      }
      // после лимита подсказок свободный ввод игнорируется (§28.16)
      await setFsmState(executor, userId, { node: node!, context: { hints: hints + 1 } });
    }
    // вне онбординга бот молчит: событие для аналитики записано (NLU — M9)
  });
}
