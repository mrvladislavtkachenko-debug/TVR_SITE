import { FakeBotDb } from '../../../bot/test/helpers/fakeDb.js';
import type { SqlExecutor } from '@tas/db/services';

/**
 * Фейк-БД воркера: расширяет ботовский (общие таблицы) ветками M6 —
 * automation_flows, flow_runs, счётчики событий, daily cap, TTL,
 * lifecycle-переходы cron. Неизвестный SQL → throw (честный фейк).
 */

interface FlowRecord {
  id: string;
  code: string;
  version: number;
  definition: Record<string, unknown>;
  status: 'draft' | 'active' | 'archived';
}

interface RunRecord {
  id: string;
  flow_id: string;
  flow_version: number;
  user_id: string;
  status: 'active' | 'completed' | 'cancelled' | 'failed';
  current_step: number;
  context: Record<string, unknown> | null;
  started_at: Date;
  finished_at: Date | null;
}

export class WorkerFakeDb extends FakeBotDb {
  flows = new Map<string, FlowRecord>();
  lastActivity = new Map<string, Date>();
  dynamicRules = new Map<string, unknown>();
  runs: RunRecord[] = [];
  runSeq = 0;
  audits: { action: string; entity: string; entity_id: string | null; meta: Record<string, unknown> }[] = [];

  seedFlow(code: string, definition: Record<string, unknown>, status: FlowRecord['status'] = 'active', version = 1): FlowRecord {
    for (const f of this.flows.values()) {
      if (f.code === code && f.version === version) return f;
    }
    const rec: FlowRecord = { id: `flow-${code}-v${version}`, code, version, definition, status };
    this.flows.set(rec.id, rec);
    return rec;
  }

  seedDynamicSegment(code: string, rule: unknown): void {
    if (!this.segments.has(code)) {
      const id = String(200 + this.segments.size);
      this.segments.set(code, { id, code });
    }
    this.dynamicRules.set(code, rule);
  }

  activeRunOf(code: string, userId: string): RunRecord | undefined {
    return this.runs.find((r) => r.flow_id === `flow-${code}-v1` && r.user_id === userId && r.status === 'active');
  }

  protected override query(sql: string, params: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    // ---- automation_flows
    if (sql.includes('FROM automation_flows') && sql.includes('WHERE code = $1')) {
      const code = String(params[0]);
      const actives = [...this.flows.values()].filter((f) => f.code === code && f.status === 'active');
      if (actives.length === 0) return { rows: [], rowCount: 0 };
      const flow = actives.reduce((a, b) => (b.version > a.version ? b : a));
      return { rows: [{ ...flow }], rowCount: 1 };
    }
    if (sql.includes('FROM automation_flows') && sql.includes("status = 'active' ORDER BY code")) {
      const byCode = new Map<string, FlowRecord>();
      for (const f of this.flows.values()) {
        if (f.status !== 'active') continue;
        const cur = byCode.get(f.code);
        if (!cur || f.version > cur.version) byCode.set(f.code, f);
      }
      const rows = [...byCode.values()].map((f) => ({ ...f }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM automation_flows WHERE id = $1')) {
      const flow = this.flows.get(String(params[0]));
      return flow ? { rows: [{ code: flow.code, version: flow.version, definition: flow.definition }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    // ---- flow_runs
    if (sql.includes('INSERT INTO flow_runs')) {
      const flowId = String(params[0] ?? '');
      const flowVersion = Number(params[1] ?? 1);
      const userId = String(params[2] ?? '');
      this.runSeq += 1;
      const rec: RunRecord = {
        id: String(this.runSeq),
        flow_id: flowId,
        flow_version: Number(flowVersion),
        user_id: userId,
        status: 'active',
        current_step: 0,
        context: {},
        started_at: new Date(),
        finished_at: null,
      };
      this.runs.push(rec);
      return { rows: [{ id: rec.id }], rowCount: 1 };
    }
    if (sql.includes('WHERE r.id = $1')) {
      const run = this.runs.find((r) => r.id === String(params[0]));
      if (!run) return { rows: [], rowCount: 0 };
      const flow = this.flows.get(run.flow_id);
      return {
        rows: [
          {
            id: run.id,
            flow_id: run.flow_id,
            flow_code: flow?.code ?? '?',
            flow_version: run.flow_version,
            user_id: run.user_id,
            status: run.status,
            current_step: run.current_step,
            context: run.context,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("WHERE r.status = 'active' ORDER BY r.id")) {
      const rows = this.runs
        .filter((r) => r.status === 'active')
        .map((r) => {
          const flow = this.flows.get(r.flow_id);
          return {
            id: r.id,
            flow_id: r.flow_id,
            flow_code: flow?.code ?? '?',
            flow_version: r.flow_version,
            user_id: r.user_id,
            status: r.status,
            current_step: r.current_step,
            context: r.context,
          };
        });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT id FROM flow_runs WHERE user_id = $1 AND flow_id = $2') && sql.includes("'active'")) {
      const run = this.runs.find(
        (r) => r.user_id === String(params[0]) && r.flow_id === String(params[1]) && r.status === 'active',
      );
      return run ? { rows: [{ id: run.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT id FROM flow_runs') && sql.includes("|| ' days'")) {
      const days = Number(params[2]);
      const cutoff = Date.now() - days * 86400_000;
      const found = this.runs.find(
        (r) =>
          r.user_id === String(params[0]) &&
          r.flow_id === String(params[1]) &&
          r.started_at.getTime() > cutoff,
      );
      return found ? { rows: [{ id: found.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE flow_runs SET current_step = $2')) {
      const run = this.runs.find((r) => r.id === String(params[0]));
      if (run) {
        run.current_step = Number(params[1]);
        const ctx = { ...(run.context ?? {}) };
        ctx.next_fire_at = JSON.parse(String(params[2])) as string;
        run.context = ctx;
      }
      return { rows: [], rowCount: run ? 1 : 0 };
    }
    if (sql.includes("UPDATE flow_runs SET status = $2, finished_at = now()")) {
      const run = this.runs.find((r) => r.id === String(params[0]));
      if (run) {
        run.status = params[1] as RunRecord['status'];
        run.finished_at = new Date();
        if (run.context) delete run.context.next_fire_at;
      }
      return { rows: [], rowCount: run ? 1 : 0 };
    }
    if (sql.includes('UPDATE flow_runs SET status = ') && sql.includes("|| ' days'") === false && sql.includes('flow_id = $2')) {
      // cancelUserRunsOfFlow
      let n = 0;
      for (const r of this.runs) {
        if (r.user_id === String(params[0]) && r.flow_id === String(params[1]) && r.status === 'active') {
          r.status = 'cancelled';
          r.finished_at = new Date();
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (sql.includes("UPDATE flow_runs SET status = 'cancelled'")) {
      // cancelActiveFlowRuns (M5): воркер-хранилище runs
      let n = 0;
      for (const r of this.runs) {
        if (r.user_id === String(params[0]) && r.status === 'active') {
          r.status = 'cancelled';
          r.finished_at = new Date();
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }

    // ---- event-poller: позиционные id (индекс+1)
    if (sql.includes('SELECT COALESCE(MAX(id), 0)::text AS max FROM events')) {
      return { rows: [{ max: String(this.events.length) }], rowCount: 1 };
    }
    if (sql.includes('SELECT id, name, user_id, properties FROM events WHERE id > $1')) {
      const after = Number(params[0]);
      const limit = Number(params[1]);
      const rows = this.events
        .map((e, i) => ({ id: String(i + 1), name: e.name, user_id: e.user_id, properties: e.properties }))
        .filter((r) => Number(r.id) > after)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // ---- счётчики событий (engine/poller/conditions)
    if (sql.includes('SELECT count(*)::int AS n FROM events') && sql.includes('make_interval')) {
      const [userId, name, hours] = [String(params[0]), String(params[1]), Number(params[2])];
      const cutoff = Date.now() - hours * 3600_000;
      const n = this.events.filter(
        (e) => e.user_id === userId && e.name === name && new Date().getTime() >= cutoff - 24 * 3600_000, // окно имитируем грубо: все события «свежие» в фейке
      ).length;
      return { rows: [{ n }], rowCount: 1 };
    }

    // ---- getUserFacts
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN user_profiles p') && sql.includes('LEFT JOIN segments s')) {
      const user = this.users.get(String(params[0]));
      if (!user) return { rows: [], rowCount: 0 };
      const profile = this.profiles.get(user.id);
      const segCode =
        profile?.interest_segment_id != null
          ? [...this.segments.values()].find((s) => s.id === profile.interest_segment_id)?.code ?? null
          : null;
      return {
        rows: [
          {
            id: user.id,
            telegram_id: user.telegram_id,
            first_name: user.first_name,
            is_blocked: user.is_blocked,
            last_activity_at: this.lastActivity.get(user.id) ?? user.first_seen_at,
            locale: user.locale,
            lifecycle_state: profile?.lifecycle_state ?? null,
            message_frequency: profile?.message_frequency ?? null,
            interest_segment_code: segCode,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT s.code FROM user_segments us')) {
      const userId = String(params[0]);
      const codes: string[] = [];
      for (const m of this.userSegments.values()) {
        if (m.user_id === userId && m.removed_at === null) {
          const seg = [...this.segments.values()].find((s) => s.id === m.segment_id);
          if (seg) codes.push(seg.code);
        }
      }
      return { rows: codes.map((code) => ({ code })), rowCount: codes.length };
    }
    if (sql.includes('SELECT telegram_id::text AS chat FROM users')) {
      const user = this.users.get(String(params[0]));
      return user ? { rows: [{ chat: user.telegram_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('EXTRACT(DAY FROM now() - first_seen_at)')) {
      return { rows: [{ d: 3 }], rowCount: 1 };
    }

    // ---- daily cap / stale / lastSent (outbox M6)
    if (sql.includes('date_trunc') && sql.includes("kind IN ('flow','broadcast')")) {
      const userId = String(params[0]);
      const todayStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      const n = this.outbox.filter(
        (o) =>
          o.user_id === userId &&
          o.status === 'sent' &&
          (o.kind === 'flow' || o.kind === 'broadcast') &&
          (o.sent_at?.getTime() ?? 0) >= todayStart.getTime(),
      ).length;
      return { rows: [{ n }], rowCount: 1 };
    }
    if (sql.includes("UPDATE messages_outbox SET status = 'pending' WHERE status = 'sending'")) {
      let n = 0;
      for (const o of this.outbox) {
        if (o.status === 'sending') {
          o.status = 'pending';
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (sql.includes('SELECT max(sent_at) AS last')) {
      const chatId = String(params[0]);
      const sent = this.outbox
        .filter((o) => (o.payload.chat_id as string) === chatId && o.sent_at !== null)
        .map((o) => o.sent_at!.getTime());
      const last = sent.length > 0 ? new Date(Math.max(...sent)) : null;
      return { rows: [{ last }], rowCount: 1 };
    }
    if (sql.includes('SELECT id, user_id, kind, template_code, payload FROM messages_outbox WHERE id = $1')) {
      const o = this.outbox.find((r) => r.id === String(params[0]));
      return o
        ? { rows: [{ id: o.id, user_id: o.user_id, kind: o.kind, template_code: o.template_code, payload: o.payload }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT status FROM messages_outbox WHERE id = $1')) {
      const o = this.outbox.find((r) => r.id === String(params[0]));
      return o ? { rows: [{ status: o.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    // ---- TTL telegram_updates
    if (sql.includes('DELETE FROM telegram_updates WHERE received_at')) {
      let n = 0;
      for (const [id, upd] of [...this.telegramUpdates.entries()]) {
        // фейк: payload хранит received_at-shift в свойстве __days_old (тест)
        const daysOld = (upd.payload as { __days_old?: number } | null)?.__days_old;
        if (typeof daysOld === 'number' && daysOld > 7) {
          this.telegramUpdates.delete(id);
          n += 1;
        }
      }
      return { rows: [{ n }], rowCount: 1 };
    }

    // ---- audit (notify_admin)
    if (sql.includes('INSERT INTO audit_logs')) {
      this.audits.push({
        action: String(params[2]),
        entity: String(params[3]),
        entity_id: params[4] === null ? null : String(params[4]),
        meta: JSON.parse(String(params[5] ?? '{}')) as Record<string, unknown>,
      });
      return { rows: [], rowCount: 1 };
    }

    // ---- lifecycle-переходы cron: семантическая имитация transition()
    if (sql.includes('UPDATE user_profiles p SET lifecycle_state = $1')) {
      const to = String(params[0]); // cron transition(): $1 = целевое состояние
      const where = sql;
      const out: Record<string, unknown>[] = [];
      for (const p of this.profiles.values()) {
        const user = this.users.get(p.user_id);
        if (!user || p.lifecycle_state === to || p.lifecycle_state === null) continue;
        const from = p.lifecycle_state;
        let matches = false;
        if (
          to === 'activated' &&
          where.includes("p.lifecycle_state = 'onboarded'")
        ) {
          const views = this.events.filter((e) => e.user_id === p.user_id && e.name === 'content_viewed').length;
          const clicks = this.events.filter((e) => e.user_id === p.user_id && e.name === 'button_clicked').length;
          matches = from === 'onboarded' && (views >= 2 || clicks >= 1);
        } else if (
          to === 'churned' &&
          where.includes("p.lifecycle_state = 'new' AND p.onboarding_completed_at IS NULL")
        ) {
          matches = from === 'new' && p.onboarding_completed_at === null && userAgeDays(user.first_seen_at) > 7;
        } else if (
          to === 'at_risk' &&
          where.includes("p.lifecycle_state IN ('activated','engaged')")
        ) {
          matches = (from === 'activated' || from === 'engaged') && daysAgoMoreThan(this.lastActivity.get(user.id) ?? user.first_seen_at, 14);
        } else if (
          to === 'churned' &&
          where.includes("p.lifecycle_state = 'at_risk'")
        ) {
          matches = from === 'at_risk' && daysAgoMoreThan(this.lastActivity.get(user.id) ?? user.first_seen_at, 30);
        } else if (
          to === 'engaged' &&
          where.includes("p.lifecycle_state = 'at_risk'")
        ) {
          matches =
            from === 'at_risk' && !daysAgoMoreThan(this.lastActivity.get(user.id) ?? user.first_seen_at, 14);
        } else if (
          to === 'engaged' &&
          where.includes("p.lifecycle_state = 'activated'")
        ) {
          const acts = this.events.filter(
            (e) =>
              e.user_id === p.user_id &&
              ['content_viewed', 'button_clicked', 'message_received'].includes(e.name),
          ).length;
          matches = from === 'activated' && acts >= 3;
        }
        if (matches) {
          p.lifecycle_state = to;
          out.push({ user_id: p.user_id, from });
        }
      }
      return { rows: out, rowCount: out.length };
    }
    if (sql.includes('UPDATE user_profiles SET activated_at')) {
      return { rows: [], rowCount: 1 };
    }

    // ---- dynamic segments
    if (sql.includes("WHERE s.kind = 'dynamic'")) {
      const rows = [...this.segments.values()]
        .filter((s) => this.dynamicRules.has(s.code))
        .map((s) => ({ id: s.id, code: s.code, rule_json: this.dynamicRules.get(s.code), max_hours: 168 }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT DISTINCT e.user_id FROM events e')) {
      const names = params[0] as string[];
      const userIds = new Set(this.events.filter((e) => e.user_id && names.includes(e.name)).map((e) => e.user_id));
      const rows = [...userIds].map((user_id) => ({ user_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT count(*)::int AS n FROM events') && sql.includes('user_id = $1 AND name = $2')) {
      const n = this.events.filter((e) => e.user_id === String(params[0]) && e.name === String(params[1])).length;
      return { rows: [{ n }], rowCount: 1 };
    }
    if (sql.includes('SELECT 1 FROM user_segments WHERE user_id = $1 AND segment_id = $2 AND removed_at IS NULL')) {
      const m = this.userSegments.get(`${String(params[0])}:${String(params[1])}`);
      const exists = m !== undefined && m.removed_at === null;
      return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
    }
    if (sql.includes('WITH rm AS')) {
      const m = this.userSegments.get(`${String(params[0])}:${String(params[1])}`);
      let n = 0;
      if (m && m.removed_at === null && m.origin === 'rule') {
        m.removed_at = new Date();
        n = 1;
      }
      return { rows: [{ n }], rowCount: 1 };
    }

    return super.query(sql, params);
  }

  get executorApi(): SqlExecutor {
    return this.executor;
  }
}

function userAgeDays(from: Date): number {
  return (Date.now() - from.getTime()) / 86400_000;
}

function daysAgoMoreThan(date: Date | undefined, days: number): boolean {
  if (!date) return false;
  return Date.now() - date.getTime() > days * 86400_000;
}
