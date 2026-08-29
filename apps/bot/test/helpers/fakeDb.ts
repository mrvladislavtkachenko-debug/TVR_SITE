import type { SqlExecutor } from '@tas/db/services';
import type { BotTemplate } from '../../src/templates.js';

/**
 * Hermetic fake-БД для тестов бота (паттерн M4): маршрутизация по SQL-шаблонам,
 * семантика PG (Э1/Э8/§28.x) соблюдена вручную. Идентификаторы — строки (как pg).
 */

interface UserRow {
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  locale: string | null;
  is_blocked: boolean;
  blocked_at: Date | null;
}

interface ProfileRow {
  user_id: string;
  lifecycle_state: string;
  fsm_state: { node: string; context: Record<string, unknown> } | null;
  interest_segment_id: string | null;
  message_frequency: 'normal' | 'low';
  onboarding_completed_at: Date | null;
}

interface AttributionRow {
  id: string;
  user_id: string;
  touch: 'first' | 'last';
  is_current: boolean;
  tracking_link_id: string;
}

interface OutboxRowDb {
  id: string;
  user_id: string;
  kind: 'flow' | 'broadcast' | 'transactional';
  template_code: string | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  telegram_message_id: string | null;
  scheduled_at: Date;
  sent_at: Date | null;
  error: string | null;
  dedup_key: string | null;
}

interface EventRow {
  name: string;
  user_id: string | null;
  tracking_link_id: string | null;
  properties: Record<string, unknown>;
  dedup_key: string | null;
}

export interface FlowRunRow {
  id: string;
  user_id: string;
  status: 'active' | 'completed' | 'cancelled' | 'failed';
}

export class FakeBotDb {
  users = new Map<string, UserRow>();
  profiles = new Map<string, ProfileRow>();
  segments = new Map<string, { id: string; code: string }>([
    { id: '101', code: 'S1' },
    { id: '102', code: 'S2' },
    { id: '103', code: 'S3' },
    { id: '104', code: 'S4' },
    { id: '105', code: 'unsubscribed' },
  ].map((s) => [s.code, s]));
  userSegments = new Map<string, { user_id: string; segment_id: string; origin: string; removed_at: Date | null }>();
  attributions: AttributionRow[] = [];
  trackingLinks = new Map<string, { id: string; short_code: string }>();
  telegramUpdates = new Map<string, { id: string; payload: unknown; processed_at: Date | null }>();
  outbox: OutboxRowDb[] = [];
  events: EventRow[] = [];
  flowRuns: FlowRunRow[] = [];
  templates = new Map<string, BotTemplate>();
  seq = { user: 0, attr: 0, outbox: 0, upd: 0, ev: 0 };

  readonly executor: SqlExecutor = {
    query: (sql, params) => Promise.resolve(this.query(sql, params)),
    execute: (sql, params) => Promise.resolve(this.query(sql, params).rowCount),
  };

  // ------------------------------------------------------------- утилиты
  nextId(counter: keyof typeof this.seq): string {
    this.seq[counter] += 1;
    return String(this.seq[counter]);
  }

  seedTrackingLink(shortCode: string): { id: string; short_code: string } {
    const row = { id: this.nextId('attr') + '0000', short_code: shortCode };
    this.trackingLinks.set(shortCode, row);
    return row;
  }

  userByTelegram(telegramId: string): UserRow | undefined {
    return [...this.users.values()].find((u) => u.telegram_id === telegramId);
  }

  outboxPending(): OutboxRowDb[] {
    return this.outbox.filter((o) => o.status === 'pending');
  }

  eventsByName(name: string): EventRow[] {
    return this.events.filter((e) => e.name === name);
  }

  // ------------------------------------------------------------- маршрутизатор
  private query(sql: string, params: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    // users: upsert по telegram_id (§28.1/28.4); is_blocked не трогаем
    if (sql.includes('INSERT INTO users') && sql.includes('ON CONFLICT (telegram_id)')) {
      const [telegramId, username, firstName, locale] = params as (string | null | undefined)[];
      const uname = username ?? null;
      const fname = firstName ?? null;
      const loc = locale ?? null;
      const existing = this.userByTelegram(String(telegramId));
      if (existing) {
        existing.username = uname ?? existing.username;
        existing.first_name = fname ?? existing.first_name;
        existing.locale = loc ?? existing.locale;
        return { rows: [{ id: existing.id, inserted: false }], rowCount: 1 };
      }
      const id = this.nextId('user');
      this.users.set(id, {
        id,
        telegram_id: String(telegramId),
        username: uname,
        first_name: fname,
        locale: loc,
        is_blocked: false,
        blocked_at: null,
      });
      return { rows: [{ id, inserted: true }], rowCount: 1 };
    }
    if (sql.includes('UPDATE users SET is_blocked = false')) {
      const user = this.users.get(String(params[0]));
      if (user && user.is_blocked) {
        user.is_blocked = false;
        user.blocked_at = null;
        const profile = this.profiles.get(user.id);
        const prev = profile?.lifecycle_state ?? 'blocked';
        if (profile && profile.lifecycle_state === 'blocked') profile.lifecycle_state = 'reactivated';
        return { rows: [{ prev }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE users SET is_blocked = true')) {
      const user = this.users.get(String(params[0]));
      if (user) {
        user.is_blocked = true;
        user.blocked_at = new Date();
      }
      return { rows: [], rowCount: user ? 1 : 0 };
    }

    // profiles
    if (sql.includes('INSERT INTO user_profiles') && sql.includes('ON CONFLICT')) {
      const userId = String(params[0]);
      if (!this.profiles.has(userId)) {
        this.profiles.set(userId, {
          user_id: userId,
          lifecycle_state: 'new',
          fsm_state: null,
          interest_segment_id: null,
          message_frequency: 'normal',
          onboarding_completed_at: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM user_profiles p') && sql.includes('LEFT JOIN segments')) {
      const p = this.profiles.get(String(params[0]));
      if (!p) return { rows: [], rowCount: 0 };
      const seg = p.interest_segment_id
        ? [...this.segments.values()].find((s) => s.id === p.interest_segment_id)
        : undefined;
      return {
        rows: [
          {
            lifecycle_state: p.lifecycle_state,
            fsm_state: p.fsm_state,
            interest_segment_id: p.interest_segment_id,
            interest_segment_code: seg?.code ?? null,
            message_frequency: p.message_frequency,
            onboarding_completed_at: p.onboarding_completed_at,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SET lifecycle_state = 'reactivated'") && !sql.includes('WITH prev')) {
      // второй стейтмент unblockUserIfBlocked: blocked → reactivated
      const p = this.profiles.get(String(params[0]));
      if (p && p.lifecycle_state === 'blocked') p.lifecycle_state = 'reactivated';
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (sql.includes('UPDATE user_profiles SET lifecycle_state')) {
      // setLifecycleState: WITH prev ... RETURNING prev
      const p = this.profiles.get(String(params[0]));
      const to = String(params[1]);
      if (!p) return { rows: [], rowCount: 0 };
      if (p.lifecycle_state === to) return { rows: [], rowCount: 0 };
      const prev = p.lifecycle_state;
      p.lifecycle_state = to;
      return { rows: [{ prev }], rowCount: 1 };
    }
    if (sql.includes('UPDATE user_profiles SET fsm_state')) {
      const p = this.profiles.get(String(params[0]));
      if (p) p.fsm_state = (params[1] as string | null) === null ? null : JSON.parse(String(params[1]));
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (sql.includes('UPDATE user_profiles SET message_frequency')) {
      const p = this.profiles.get(String(params[0]));
      if (p) p.message_frequency = params[1] as 'normal' | 'low';
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (sql.includes('UPDATE user_profiles SET interest_segment_id')) {
      const p = this.profiles.get(String(params[0]));
      if (p) p.interest_segment_id = String(params[1]);
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (sql.includes('UPDATE user_profiles SET onboarding_completed_at')) {
      const p = this.profiles.get(String(params[0]));
      if (p && p.onboarding_completed_at === null) {
        p.onboarding_completed_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // segments
    if (sql.includes('FROM segments WHERE code')) {
      const seg = this.segments.get(String(params[0]));
      return seg ? { rows: [{ id: seg.id, code: seg.code }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO user_segments')) {
      const isOnboardingLiteral = sql.includes("'onboarding'");
      const userId = String(params[0] ?? '');
      const segmentId = String(params[1] ?? '');
      const origin = String(params[2] ?? 'manual');
      const key = `${userId}:${segmentId}`;
      const existing = this.userSegments.get(key);
      if (existing) {
        existing.removed_at = null;
      } else {
        this.userSegments.set(key, {
          user_id: userId,
          segment_id: segmentId,
          origin: isOnboardingLiteral ? 'onboarding' : origin,
          removed_at: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE user_segments SET removed_at = now()')) {
      if (sql.includes('AND segment_id <>')) {
        // setInterestSegment: закрыть другие onboarding-членства
        const userId = String(params[0] ?? '');
        const segmentId = String(params[1] ?? '');
        let n = 0;
        for (const m of this.userSegments.values()) {
          if (m.user_id === userId && m.segment_id !== segmentId && m.removed_at === null && m.origin === 'onboarding') {
            m.removed_at = new Date();
            n += 1;
          }
        }
        return { rows: [], rowCount: n };
      }
      const userId = String(params[0] ?? '');
      const segmentId = String(params[1] ?? '');
      const m = this.userSegments.get(`${userId}:${segmentId}`);
      if (m && m.removed_at === null) {
        m.removed_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // attribution
    if (sql.includes('FROM tracking_links WHERE short_code')) {
      const row = this.trackingLinks.get(String(params[0]));
      return row
        ? {
            rows: [
              {
                id: row.id,
                short_code: row.short_code,
                source_id: 'pinterest',
                campaign_id: null,
                cluster_id: null,
                keyword_id: null,
                pin_id: null,
                landing_slug: 'morning-checklist',
                creative_variant: 'A',
                landing_variant: null,
                placement: null,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE attributions SET is_current = false')) {
      // recordStartTouch стейтмент 1: снять is_current с чужого текущего last
      const [userId, trackingLinkId] = [String(params[0] ?? ''), String(params[1] ?? '')];
      for (const a of this.attributions) {
        if (
          a.user_id === userId &&
          a.touch === 'last' &&
          a.is_current &&
          a.tracking_link_id !== trackingLinkId
        ) {
          a.is_current = false;
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('WITH ins_first AS')) {
      // recordStartTouch стейтмент 2: first ровно один раз; last is_current один
      const [userId, trackingLinkId] = [String(params[0] ?? ''), String(params[1] ?? '')];
      const hasFirst = this.attributions.some((a) => a.user_id === userId && a.touch === 'first');
      const currentLast = this.attributions.find(
        (a) => a.user_id === userId && a.touch === 'last' && a.is_current,
      );
      let firsts = 0;
      let lasts = 0;
      if (!hasFirst) {
        this.attributions.push({
          id: this.nextId('attr'),
          user_id: userId,
          touch: 'first',
          is_current: false,
          tracking_link_id: trackingLinkId,
        });
        firsts = 1;
      }
      if (!currentLast || currentLast.tracking_link_id !== trackingLinkId) {
        this.attributions.push({
          id: this.nextId('attr'),
          user_id: userId,
          touch: 'last',
          is_current: true,
          tracking_link_id: trackingLinkId,
        });
        lasts = 1;
      }
      return { rows: [{ firsts, lasts }], rowCount: 1 };
    }

    // telegram_updates (§28.9)
    if (sql.includes('INSERT INTO telegram_updates')) {
      const updateId = String(params[0]);
      if (this.telegramUpdates.has(updateId)) return { rows: [], rowCount: 0 };
      const id = this.nextId('upd');
      this.telegramUpdates.set(updateId, { id, payload: params[1], processed_at: null });
      return { rows: [{ id, update_id: updateId }], rowCount: 1 };
    }
    if (sql.includes('UPDATE telegram_updates SET processed_at')) {
      const upd = [...this.telegramUpdates.values()].find((u) => u.id === String(params[0]));
      if (upd) upd.processed_at = new Date();
      return { rows: [], rowCount: upd ? 1 : 0 };
    }

    // events (Э8)
    if (sql.includes('INSERT INTO events')) {
      let inserted = 0;
      const n = params.length / 6;
      for (let i = 0; i < n; i++) {
        const b = i * 6;
        const dedupKey = (params[b + 5] as string | null) ?? null;
        if (dedupKey && this.events.some((e) => e.dedup_key === dedupKey)) continue;
        this.events.push({
          name: String(params[b]),
          user_id: params[b + 1] === null ? null : String(params[b + 1]),
          tracking_link_id: params[b + 2] === null ? null : String(params[b + 2]),
          properties: JSON.parse(String(params[b + 4])) as Record<string, unknown>,
          dedup_key: dedupKey,
        });
        inserted += 1;
      }
      return { rows: [], rowCount: inserted };
    }

    // messages_outbox
    if (sql.includes('INSERT INTO messages_outbox')) {
      const n = params.length / 6;
      let inserted = 0;
      for (let i = 0; i < n; i++) {
        const b = i * 6;
        const dedupKey = (params[b + 4] as string | null) ?? null;
        if (dedupKey && this.outbox.some((o) => o.dedup_key === dedupKey)) continue;
        this.outbox.push({
          id: this.nextId('outbox'),
          user_id: String(params[b]),
          kind: params[b + 1] as OutboxRowDb['kind'],
          template_code: params[b + 2] === null ? null : String(params[b + 2]),
          payload: JSON.parse(String(params[b + 3])) as Record<string, unknown>,
          status: 'pending',
          telegram_message_id: null,
          scheduled_at: params[b + 5] instanceof Date ? (params[b + 5] as Date) : new Date(),
          sent_at: null,
          error: null,
          dedup_key: dedupKey,
        });
        inserted += 1;
      }
      return { rows: [], rowCount: inserted };
    }
    if (sql.includes("SET status = 'sending'")) {
      const limit = Number(params[0]);
      const due = this.outbox
        .filter((o) => o.status === 'pending' && o.scheduled_at.getTime() <= Date.now())
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, limit);
      for (const o of due) o.status = 'sending';
      return {
        rows: due.map((o) => ({
          id: o.id,
          user_id: o.user_id,
          kind: o.kind,
          template_code: o.template_code,
          payload: o.payload,
        })),
        rowCount: due.length,
      };
    }
    if (sql.includes("SET status = 'sent'")) {
      const o = this.outbox.find((r) => r.id === String(params[0]));
      if (o) {
        o.status = 'sent';
        o.telegram_message_id = String(params[1]);
        o.sent_at = new Date();
      }
      return { rows: [], rowCount: o ? 1 : 0 };
    }
    if (sql.includes("SET status = 'pending', error")) {
      const o = this.outbox.find((r) => r.id === String(params[0]));
      if (o) {
        o.status = 'pending';
        o.error = String(params[2]);
        o.scheduled_at = params[1] instanceof Date ? (params[1] as Date) : new Date(String(params[1]));
      }
      return { rows: [], rowCount: o ? 1 : 0 };
    }
    if (sql.includes("SET status = 'failed'")) {
      const o = this.outbox.find((r) => r.id === String(params[0]));
      if (o) {
        o.status = 'failed';
        o.error = String(params[1]);
        o.sent_at = new Date();
      }
      return { rows: [], rowCount: o ? 1 : 0 };
    }
    if (sql.includes("SET status = 'skipped'")) {
      const allKinds = !sql.includes("kind IN ('flow','broadcast')");
      let n = 0;
      for (const o of this.outbox) {
        if (
          o.user_id === String(params[0]) &&
          (o.status === 'pending' || o.status === 'sending') &&
          (allKinds || o.kind === 'flow' || o.kind === 'broadcast')
        ) {
          o.status = 'skipped';
          o.sent_at = new Date();
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }

    // flow_runs
    if (sql.includes("UPDATE flow_runs SET status = 'cancelled'")) {
      let n = 0;
      for (const r of this.flowRuns) {
        if (r.user_id === String(params[0]) && r.status === 'active') {
          r.status = 'cancelled';
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }

    throw new Error(`FakeBotDb: неизвестный SQL: ${sql.slice(0, 120)}`);
  }
}

/** Тот же набор шаблонов, что и в seed.ts (M5) — для map-хранилища в тестах. */
export function seedBotTemplates(db: FakeBotDb): void {
  const menu = [
    { text: '📚 Получить чек-лист', type: 'callback', data: 'lm:again' },
    { text: '🎯 Мой план', type: 'callback', data: 'plan:show' },
    { text: '🛍 Products', type: 'callback', data: 'products:list' },
    { text: '💬 Оценить бота', type: 'callback', data: 'feedback:ask' },
    { text: '⚙️ Settings', type: 'callback', data: 'settings:open' },
  ];
  // кнопки сразу в TgButton-формате ({text, callbackData})
  const put = (
    code: string,
    body: string,
    buttons: { text: string; type: 'callback'; data: string }[] | null = null,
  ) =>
    db.templates.set(code, {
      body,
      buttons: buttons === null ? null : buttons.map((b) => ({ text: b.text, callbackData: b.data })),
    });
  put('bot_welcome_doc', 'Привет, {{first_name}}! 👋 Твой чек-лист — в файле ниже.');
  put('bot_q1', 'Что для тебя актуальнее всего прямо сейчас?', [
    { text: 'Рутины и порядок', type: 'callback', data: 'q1:S1' },
    { text: 'Самостоятельность', type: 'callback', data: 'q1:S2' },
    { text: 'Шаблоны и процессы', type: 'callback', data: 'q1:S3' },
    { text: 'Привычки и мотивация', type: 'callback', data: 'q1:S4' },
  ]);
  for (const [code, body] of [
    ['bot_qw_s1', 'Понял! Вот 3 шага (S1): …'],
    ['bot_qw_s2', 'Понял! Вот 3 шага (S2): …'],
    ['bot_qw_s3', 'Понял! Вот 3 шага (S3): …'],
    ['bot_qw_s4', 'Понял! Вот 3 шага (S4): …'],
  ] as const) {
    put(code, body);
  }
  put('bot_q2', 'Я буду присылать короткие советы 2–3 раза в неделю. Ок?', [
    { text: 'Отлично 👍', type: 'callback', data: 'q2:normal' },
    { text: 'Реже, пожалуйста', type: 'callback', data: 'q2:low' },
  ]);
  put('bot_menu', 'Главное меню — выбирай:', menu as { text: string; type: 'callback'; data: string }[]);
  put('bot_welcome_back', 'С возвращением, {{first_name}}! 👋 Всё под рукой:', menu as { text: string; type: 'callback'; data: string }[]);
  put('bot_lm_again', 'Держи чек-лист ещё раз 📄');
  put('bot_plan_no_segment', 'Сначала выбери тему — нажми /start.');
  put('bot_products_soon', 'Каталог продуктов скоро появится.');
  put('bot_feedback', 'Как тебе бот? Один клик:', [
    { text: '👍', type: 'callback', data: 'fb:good' },
    { text: '👎', type: 'callback', data: 'fb:bad' },
  ]);
  put('bot_feedback_thanks', 'Спасибо за оценку!');
  put('bot_settings', 'Как часто присылать советы?', [
    { text: 'Нормально', type: 'callback', data: 'setfreq:normal' },
    { text: 'Реже', type: 'callback', data: 'setfreq:low' },
  ]);
  put('bot_settings_done', 'Готово: частота {{frequency}} ✅');
  put('bot_stop', 'Готово — цепочки выключены. Вернуться: /start');
  put('bot_help', 'Что я умею: /menu, /settings, /stop…');
  put('bot_support', 'Напиши вопрос в чат — владелец читает.');
  put('bot_fsm_hint', 'Пожалуйста, выбери вариант кнопкой ниже 👇');
}
