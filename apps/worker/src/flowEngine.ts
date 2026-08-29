import { z } from 'zod';
import type { BotEventSpec, SqlExecutor, TemplateStore } from '@tas/db/services';
import {
  addSegmentMembership,
  advanceFlowRun,
  cancelUserRunsOfFlow,
  countUserEvents,
  emitSafeBotEvent,
  enqueueOutbox,
  finishFlowRun,
  getActiveFlow,
  getChatIdForUser,
  getFlowDefinitionById,
  getFlowRun,
  getSegmentByCode,
  getTemplateStoreVars,
  getUserFacts,
  getUserSegmentCodes,
  listActiveFlows,
  removeSegmentMembership,
  setProfileFieldWhitelisted,
  startFlowRun,
  writeAudit,
} from './engineDeps.js';
import { listActiveRuns } from '@tas/db/services';

/**
 * Интерпретатор automation_flows (PRD §13.1, M6).
 * Расширение схемы против буквы §13.1: guard.repeat_days (число) — материализация
 * правила §28.6 «win-back не дублируется 30 дней» (AN-27).
 */

// ---------------------------------------------------------------- схемы §13.1
const eventExprSchema = z.string(); // 'event(NAME) within Nh' | 'no event(NAME) within Nh'

export const conditionSchema = z.union([
  z.object({
    field: z.string(),
    op: z.enum(['eq', 'ne', 'in', 'not_in']),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  }),
  z.object({ expr: eventExprSchema }),
]);

export const flowButtonSchema = z.object({
  text: z.string().min(1).max(64),
  type: z.enum(['callback', 'stars_invoice']),
  data: z.string().max(64).optional(),
  product: z.string().max(64).optional(),
});

export const stepSchema = z.union([
  z.object({
    action: z.literal('send_message'),
    template: z.string(),
    delay_hours: z.number().min(0).default(0),
    buttons: z.array(flowButtonSchema).optional(),
  }),
  z.object({ action: z.literal('add_segment'), segment: z.string(), delay_hours: z.number().min(0).default(0) }),
  z.object({ action: z.literal('remove_segment'), segment: z.string(), delay_hours: z.number().min(0).default(0) }),
  z.object({
    action: z.literal('set_profile_field'),
    field: z.string(),
    value: z.unknown(),
    delay_hours: z.number().min(0).default(0),
  }),
  z.object({ action: z.literal('delay'), hours: z.number().min(0) }),
  z.object({
    branch: z.object({ if: z.string(), then: z.string(), else: z.string().optional() }),
  }),
  z.object({ action: z.literal('notify_admin'), message: z.string(), delay_hours: z.number().min(0).default(0) }),
  z.object({ action: z.literal('cancel_flow'), flow_code: z.string().optional(), delay_hours: z.number().min(0).default(0) }),
]);

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: z.string() }),
  z.object({ type: z.literal('segment_entered'), segment: z.string() }),
  z.object({ type: z.literal('state_changed'), from: z.string().optional(), to: z.string().optional() }),
  z.object({ type: z.literal('schedule'), cron: z.string() }),
  z.object({ type: z.literal('manual') }),
]);

export const guardSchema = z.object({
  cancel_if: z.array(z.enum(['user_blocked', 'unsubscribed', 'purchased_product'])).default([]),
  /** §28.6: не запускать флоу, если прогон уже был за окно дней. */
  repeat_days: z.number().int().positive().max(365).optional(),
});

export const flowDefinitionSchema = z.object({
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).default([]),
  steps: z.array(stepSchema).min(1),
  guard: guardSchema.default({ cancel_if: [] }),
});

export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
export type FlowStep = z.infer<typeof stepSchema>;
export type FlowTrigger = z.infer<typeof triggerSchema>;
export type FlowCondition = z.infer<typeof conditionSchema>;

export function parseFlowDefinition(json: unknown): FlowDefinition | null {
  const parsed = flowDefinitionSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------- выражения
export interface EventExpr {
  negated: boolean;
  event: string;
  hours: number;
}

const EXPR_RE = /^(no\s+)?event\(([A-Za-z0-9_]+)\)\s+within\s+(\d+)h$/;

export function parseEventExpr(expr: string): EventExpr | null {
  const m = EXPR_RE.exec(expr.trim());
  if (!m) return null;
  return { negated: m[1] !== undefined, event: m[2]!, hours: Number(m[3]) };
}

// ---------------------------------------------------------------- контекст
export interface EngineCtx {
  facts: {
    lifecycle_state: string | null;
    message_frequency: 'normal' | 'low' | null;
    locale: string | null;
    interest_segment: string | null;
    is_blocked: boolean;
    first_name: string | null;
  };
  segments: ReadonlySet<string>;
  counter(event: string, hours: number): Promise<number>;
}

/** Вычислить условие (чистая функция над контекстом). */
export async function evalCondition(cond: FlowCondition, ctx: EngineCtx): Promise<boolean> {
  if ('expr' in cond) {
    const expr = parseEventExpr(cond.expr);
    if (!expr) return false; // нераспознанное выражение — условие не выполнено
    const n = await ctx.counter(expr.event, expr.hours);
    return expr.negated ? n === 0 : n > 0;
  }
  const { field, op } = cond;
  let actual: unknown;
  switch (field) {
    case 'user.segment':
    case 'user.segments':
      actual = [...ctx.segments];
      break;
    case 'user.interest_segment':
      actual = ctx.facts.interest_segment;
      break;
    case 'user.message_frequency':
      actual = ctx.facts.message_frequency;
      break;
    case 'user.lifecycle_state':
      actual = ctx.facts.lifecycle_state;
      break;
    case 'user.locale':
      actual = ctx.facts.locale;
      break;
    default:
      return false; // неизвестное поле — условие не выполнено
  }
  switch (op) {
    case 'eq':
      return actual === cond.value;
    case 'ne':
      return actual !== cond.value;
    case 'in':
      return Array.isArray(cond.value) && Array.isArray(actual)
        ? actual.some((a) => (cond.value as string[]).includes(a))
        : false;
    case 'not_in':
      return Array.isArray(cond.value) && Array.isArray(actual)
        ? !actual.some((a) => (cond.value as string[]).includes(a))
        : false;
    default:
      return false;
  }
}

export async function evalConditions(conds: FlowCondition[], ctx: EngineCtx): Promise<boolean> {
  for (const c of conds) {
    if (!(await evalCondition(c, ctx))) return false;
  }
  return conds.length > 0 || true; // пустой список = безусловный запуск
}

/** Проверка guard cancel_if (§13.1). Возвращает причину или null. */
export async function guardCancelReason(
  cancelIf: string[],
  ctx: EngineCtx,
): Promise<'user_blocked' | 'unsubscribed' | 'purchased_product' | null> {
  for (const reason of cancelIf) {
    if (reason === 'user_blocked' && ctx.facts.is_blocked) return reason;
    if (reason === 'unsubscribed' && ctx.segments.has('unsubscribed')) return reason;
    if (reason === 'purchased_product' && (await ctx.counter('purchase_completed', 24 * 365)) > 0) {
      return reason;
    }
  }
  return null;
}

// ---------------------------------------------------------------- движок
export interface EngineDeps {
  executor: SqlExecutor;
  templates: TemplateStore;
  scheduler: StepScheduler;
  log: EngineLogger;
}

export interface EngineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface StepScheduler {
  /** Идемпотентно (по jobId fr:{run}:{step}) запланировать шаг на fireAt. */
  scheduleStep(runId: string, step: number, fireAt: Date): Promise<void>;
}

async function buildCtx(deps: EngineDeps, userId: string): Promise<EngineCtx | null> {
  const facts = await getUserFacts(deps.executor, userId);
  if (!facts) return null;
  const segments = await getUserSegmentCodes(deps.executor, userId);
  return {
    facts: {
      lifecycle_state: facts.lifecycle_state,
      message_frequency: facts.message_frequency,
      locale: facts.locale,
      interest_segment: facts.interest_segment_code,
      is_blocked: facts.is_blocked,
      first_name: facts.first_name,
    },
    segments: new Set(segments),
    counter: (event, hours) => countUserEvents({ executor: deps.executor }, { userId, name: event, hours }),
  };
}

/** Триггер события соответствует пришедшему событию? (чистая функция) */
export function triggerMatchesEvent(
  trigger: FlowTrigger,
  event: { name: string; properties: Record<string, unknown> },
): boolean {
  switch (trigger.type) {
    case 'event':
      return trigger.event === event.name;
    case 'segment_entered':
      return event.name === 'segment_assigned' && event.properties.segment_code === trigger.segment;
    case 'state_changed':
      return (
        event.name === 'user_state_changed' &&
        (trigger.to === undefined || event.properties.to === trigger.to) &&
        (trigger.from === undefined || event.properties.from === trigger.from)
      );
    case 'schedule':
    case 'manual':
      return false; // не событийные: schedule — cron, manual — admin API (M8)
    default:
      return false;
  }
}

export interface FlowStartLog {
  flow: string;
  user: string;
  runId: string;
  skipped: string | null;
}

/**
 * Событийный вход движка: подобрать активные флоу под событие, проверить
 * conditions/guard, создать прогоны (дедуп: active/repeat_days), запланировать
 * шаг 0 с delay_steps[0].delay_hours.
 */
export async function onEvent(deps: EngineDeps, event: BotEventSpec & { userId: string }): Promise<FlowStartLog[]> {
  const flows = await listActiveFlows(deps.executor);
  const result: FlowStartLog[] = [];
  for (const flow of flows) {
    const def = parseFlowDefinition(flow.definition);
    if (!def) {
      deps.log.error({ flow: flow.code }, 'flow definition invalid');
      continue;
    }
    if (!triggerMatchesEvent(def.trigger, event)) continue;

    const ctx = await buildCtx(deps, event.userId);
    if (!ctx) continue;
    if (!(await evalConditions(def.conditions, ctx))) continue;
    const cancelReason = await guardCancelReason(def.guard.cancel_if, ctx);
    if (cancelReason) {
      result.push({ flow: flow.code, user: event.userId, runId: '', skipped: `guard:${cancelReason}` });
      continue;
    }
    const started = await startFlowRun(deps.executor, {
      flowId: flow.id,
      flowVersion: flow.version,
      userId: event.userId,
      repeatDays: def.guard.repeat_days,
    });
    if (started.skippedReason) {
      result.push({ flow: flow.code, user: event.userId, runId: started.runId, skipped: started.skippedReason });
      continue;
    }
    const delayHours = firstStepDelayHours(def);
    const fireAt = new Date(Date.now() + delayHours * 3600_000);
    await advanceFlowRun(deps.executor, started.runId, 0, fireAt);
    await deps.scheduler.scheduleStep(started.runId, 0, fireAt);
    result.push({ flow: flow.code, user: event.userId, runId: started.runId, skipped: null });
  }
  return result;
}

function firstStepDelayHours(def: FlowDefinition): number {
  const step = def.steps[0]!;
  return 'delay_hours' in step ? (step.delay_hours ?? 0) : 0;
}

export interface StepOutcome {
  runId: string;
  step: number;
  effect: string;
  finished: boolean;
  nextStep?: number;
  nextFireAt?: Date;
}

/**
 * Выполнить шаг N прогона (вызывается BullMQ-воркером в момент срабатывания).
 * Идемпотентность: повторный вызов того же шага не дублирует отправку
 * (dedup_key {flow_run}:{step} в outbox; jobId в очереди).
 */
export async function processStep(deps: EngineDeps, runId: string, stepIndex: number): Promise<StepOutcome | null> {
  const run = await getFlowRun(deps.executor, runId);
  if (!run || run.status !== 'active') return null;
  const flow = await getFlowDefinitionById(deps.executor, run.flow_id);
  if (!flow) {
    await finishFlowRun(deps.executor, runId, 'failed');
    return { runId, step: stepIndex, effect: 'flow definition missing', finished: true };
  }
  const def = parseFlowDefinition(flow.definition);
  if (!def) {
    await finishFlowRun(deps.executor, runId, 'failed');
    return { runId, step: stepIndex, effect: 'flow definition invalid', finished: true };
  }

  // guard на каждом шаге (§13.1 guard.cancel_if)
  const ctx = await buildCtx(deps, run.user_id);
  if (!ctx) {
    await finishFlowRun(deps.executor, runId, 'failed');
    return { runId, step: stepIndex, effect: 'user missing', finished: true };
  }
  const cancelReason = await guardCancelReason(def.guard.cancel_if, ctx);
  if (cancelReason) {
    await finishFlowRun(deps.executor, runId, 'cancelled');
    return { runId, step: stepIndex, effect: `guard:${cancelReason}`, finished: true };
  }

  const step = def.steps[stepIndex];
  if (!step) {
    await finishFlowRun(deps.executor, runId, 'completed');
    return { runId, step: stepIndex, effect: 'no more steps', finished: true };
  }

  // -------------------------------------------------------------- действие
  if ('branch' in step) {
    const expr = parseEventExpr(step.branch.if);
    let conditionHolds = false;
    if (expr) {
      const n = await ctx.counter(expr.event, expr.hours);
      conditionHolds = expr.negated ? n === 0 : n > 0;
    }
    const targetRaw = conditionHolds ? step.branch.then : step.branch.else;
    await finishFlowRun(deps.executor, runId, 'completed');
    if (targetRaw) {
      // §13.1: цели записаны как goto(CODE)
      const target = /^goto\(([A-Za-z0-9_]+)\)$/.exec(targetRaw)?.[1] ?? targetRaw;
      const gotoLog = await startTargetFlow(deps, run.user_id, target);
      return { runId, step: stepIndex, effect: `branch→${target} (${gotoLog?.skipped ?? 'started'})`, finished: true };
    }
    return { runId, step: stepIndex, effect: 'branch→(end)', finished: true };
  }

  switch (step.action) {
    case 'send_message': {
      const chatId = await getChatIdForUser(deps.executor, run.user_id);
      const tpl = await deps.templates.get(step.template);
      if (!chatId) {
        await finishFlowRun(deps.executor, runId, 'failed');
        return { runId, step: stepIndex, effect: 'no chat_id', finished: true };
      }
      const vars = getTemplateStoreVars(ctx);
      const text = tpl ? renderBody(tpl.body, vars) : `{{template ${step.template} missing}}`;
      if (!tpl) deps.log.error({ template: step.template }, 'flow template missing');
      const buttons = stepButtons(step.buttons, tpl?.buttons ?? null, deps);
      const inserted = await enqueueOutbox(deps.executor, [
        {
          userId: run.user_id,
          kind: 'flow',
          templateCode: step.template,
          payload: { chat_id: chatId, text, ...(buttons ? { buttons } : {}) },
          dedupKey: `${runId}:${stepIndex}`,
        },
      ]);
      return advance(deps, runId, stepIndex, def, `send_message(${step.template}, outbox+${inserted})`);
    }
    case 'add_segment': {
      const seg = await getSegmentByCode(deps.executor, step.segment);
      if (seg) {
        await addSegmentMembership(deps.executor, { userId: run.user_id, segmentId: seg.id, origin: 'rule' });
        await emitSafeBotEvent(deps.executor, {
          name: 'segment_assigned',
          userId: run.user_id,
          properties: { segment_code: step.segment, origin: 'rule' },
          dedupKey: `run:${runId}:${stepIndex}:segment_assigned`,
        });
      } else {
        deps.log.error({ segment: step.segment }, 'flow add_segment: segment missing');
      }
      return advance(deps, runId, stepIndex, def, `add_segment(${step.segment})`);
    }
    case 'remove_segment': {
      const seg = await getSegmentByCode(deps.executor, step.segment);
      if (seg) await removeSegmentMembership(deps.executor, run.user_id, seg.id);
      return advance(deps, runId, stepIndex, def, `remove_segment(${step.segment})`);
    }
    case 'set_profile_field': {
      const ok = await setProfileFieldWhitelisted(deps.executor, run.user_id, step.field, step.value);
      if (!ok) deps.log.warn({ field: step.field }, 'set_profile_field: поле вне whitelist');
      return advance(deps, runId, stepIndex, def, `set_profile_field(${step.field})`);
    }
    case 'delay':
      return advance(deps, runId, stepIndex, def, `delay(${step.hours}h)`, step.hours);
    case 'notify_admin': {
      await writeAudit(deps.executor, {
        actorType: 'system',
        action: 'notify_admin',
        entity: 'flow',
        entityId: flow.code,
        meta: { message: step.message, user_id: run.user_id, run_id: runId },
      });
      deps.log.warn({ flow: flow.code, user_id: run.user_id, message: step.message }, 'notify_admin');
      return advance(deps, runId, stepIndex, def, 'notify_admin');
    }
    case 'cancel_flow': {
      if (step.flow_code) {
        const target = await getActiveFlow(deps.executor, step.flow_code);
        if (target) {
          await cancelUserRunsOfFlow(deps.executor, run.user_id, target.id);
        }
      } else {
        await finishFlowRun(deps.executor, runId, 'cancelled');
        return { runId, step: stepIndex, effect: 'cancel_flow(self)', finished: true };
      }
      return advance(deps, runId, stepIndex, def, `cancel_flow(${step.flow_code})`);
    }
    default: {
      await finishFlowRun(deps.executor, runId, 'failed');
      return { runId, step: stepIndex, effect: 'unknown action', finished: true };
    }
  }
}

async function advance(
  deps: EngineDeps,
  runId: string,
  stepIndex: number,
  def: FlowDefinition,
  effect: string,
  extraDelayHours = 0,
): Promise<StepOutcome> {
  const nextStep = stepIndex + 1;
  const next = def.steps[nextStep];
  if (!next) {
    await finishFlowRun(deps.executor, runId, 'completed');
    return { runId, step: stepIndex, effect, finished: true };
  }
  const delayHours = ('delay_hours' in next ? (next.delay_hours ?? 0) : 0) + extraDelayHours;
  const fireAt = new Date(Date.now() + delayHours * 3600_000);
  await advanceFlowRun(deps.executor, runId, nextStep, fireAt);
  await deps.scheduler.scheduleStep(runId, nextStep, fireAt);
  return { runId, step: stepIndex, effect, finished: false, nextStep, nextFireAt: fireAt };
}

async function startTargetFlow(deps: EngineDeps, userId: string, code: string): Promise<FlowStartLog | null> {
  const flow = await getActiveFlow(deps.executor, code);
  if (!flow) {
    deps.log.warn({ flow: code }, 'branch goto: flow not found/active');
    return null;
  }
  const def = parseFlowDefinition(flow.definition);
  if (!def) return null;
  const started = await startFlowRun(deps.executor, {
    flowId: flow.id,
    flowVersion: flow.version,
    userId,
    repeatDays: def.guard.repeat_days,
  });
  if (!started.skippedReason) {
    const fireAt = new Date(Date.now() + firstStepDelayHours(def) * 3600_000);
    await advanceFlowRun(deps.executor, started.runId, 0, fireAt);
    await deps.scheduler.scheduleStep(started.runId, 0, fireAt);
  }
  return { flow: code, user: userId, runId: started.runId, skipped: started.skippedReason };
}

/**
 * Rehydrate (контракт M6): активные прогоны → перепланирование текущего шага
 * на next_fire_at из контекста (или немедленно). Идемпотентно по jobId.
 */
export async function rehydrateActiveRuns(
  deps: EngineDeps,
  now = new Date(),
): Promise<{ runs: number; scheduled: number }> {
  const runs = await listActiveRuns(deps.executor);
  let scheduled = 0;
  for (const run of runs) {
    const fireAtRaw = run.context?.next_fire_at;
    const fireAt = fireAtRaw ? new Date(String(fireAtRaw)) : now;
    const at = Number.isNaN(fireAt.getTime()) || fireAt.getTime() < now.getTime() ? now : fireAt;
    await deps.scheduler.scheduleStep(run.id, run.current_step, at);
    scheduled += 1;
  }
  return { runs: runs.length, scheduled };
}

// ---------------------------------------------------------------- helpers
function renderBody(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

function stepButtons(
  stepButtonsRaw: { text: string; type: 'callback' | 'stars_invoice'; data?: string; product?: string }[] | undefined,
  tplButtons: { text: string; callbackData: string }[] | null,
  deps: EngineDeps,
): { text: string; callbackData: string }[] | null {
  if (!stepButtonsRaw || stepButtonsRaw.length === 0) return tplButtons;
  const mapped: { text: string; callbackData: string }[] = [];
  for (const b of stepButtonsRaw) {
    if (b.type === 'callback' && b.data) mapped.push({ text: b.text, callbackData: b.data });
    else deps.log.warn({ product: b.product }, 'stars_invoice-кнопка: счета — M7 (шаг отправлен текстом)');
  }
  return mapped.length > 0 ? mapped : null;
}
