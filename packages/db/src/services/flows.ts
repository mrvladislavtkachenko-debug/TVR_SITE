import type { SqlExecutor } from './sql.js';

/**
 * automation_flows / flow_runs (§13.1): только одна active версия на code;
 * шаги материализуются BullMQ delayed-джобами (idempotent по jobId), контекст
 * next_fire_at — в flow_runs.context (переживает рестарт, rehydrate на старте).
 */

export interface FlowRow {
  id: string;
  code: string;
  version: number;
  definition: Record<string, unknown>;
}

/** Активная версия флоу (единственная по контракту; берём максимальную). */
export async function getActiveFlow(executor: SqlExecutor, code: string): Promise<FlowRow | null> {
  const result = await executor.query(
    `SELECT id, code, version, definition FROM automation_flows
     WHERE code = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`,
    [code],
  );
  const row = result.rows[0] as
    | { id: string | bigint; code: string; version: number; definition: Record<string, unknown> }
    | undefined;
  return row
    ? {
        id: String(row.id),
        code: row.code,
        version: row.version,
        definition: row.definition,
      }
    : null;
}

/** Все активные флоу (для матрицы триггеров event-poller'а). */
export async function listActiveFlows(executor: SqlExecutor): Promise<FlowRow[]> {
  const result = await executor.query(
    `SELECT id, code, version, definition FROM automation_flows
     WHERE status = 'active' ORDER BY code, version DESC`,
    [],
  );
  const seen = new Set<string>();
  const flows: FlowRow[] = [];
  for (const raw of result.rows as { id: string | bigint; code: string; version: number; definition: Record<string, unknown> }[]) {
    if (seen.has(raw.code)) continue; // только максимальная active-версия
    seen.add(raw.code);
    flows.push({ id: String(raw.id), code: raw.code, version: raw.version, definition: raw.definition });
  }
  return flows;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  flow_code: string;
  flow_version: number;
  user_id: string;
  status: 'active' | 'completed' | 'cancelled' | 'failed';
  current_step: number;
  context: Record<string, unknown> | null;
}

export async function getFlowRun(executor: SqlExecutor, runId: string): Promise<FlowRunRow | null> {
  const result = await executor.query(
    `SELECT r.id, r.flow_id, f.code AS flow_code, r.flow_version, r.user_id,
            r.status, r.current_step, r.context
     FROM flow_runs r JOIN automation_flows f ON f.id = r.flow_id
     WHERE r.id = $1`,
    [runId],
  );
  return mapRun(result.rows[0]);
}

export async function listActiveRuns(executor: SqlExecutor): Promise<FlowRunRow[]> {
  const result = await executor.query(
    `SELECT r.id, r.flow_id, f.code AS flow_code, r.flow_version, r.user_id,
            r.status, r.current_step, r.context
     FROM flow_runs r JOIN automation_flows f ON f.id = r.flow_id
     WHERE r.status = 'active' ORDER BY r.id`,
    [],
  );
  return result.rows.map((row) => mapRun(row)).filter((r): r is FlowRunRow => r !== null);
}

function mapRun(raw: unknown): FlowRunRow | null {
  if (!raw) return null;
  const r = raw as {
    id: string | bigint;
    flow_id: string | bigint;
    flow_code: string;
    flow_version: number;
    user_id: string | bigint;
    status: FlowRunRow['status'];
    current_step: number;
    context: Record<string, unknown> | null;
  };
  return {
    id: String(r.id),
    flow_id: String(r.flow_id),
    flow_code: r.flow_code,
    flow_version: r.flow_version,
    user_id: String(r.user_id),
    status: r.status,
    current_step: r.current_step,
    context: r.context ?? null,
  };
}

export interface StartRunResult {
  runId: string;
  skippedReason: 'active_exists' | 'repeat_guard' | null;
}

/**
 * Создать прогон. Дедуп: (1) активный прогон того же флоу у пользователя;
 * (2) guard repeat_days — любой прогон этого флоу у пользователя за окно
 * (§28.6: win-back не дублируется 30 дней).
 */
export async function startFlowRun(
  executor: SqlExecutor,
  input: { flowId: string; flowVersion: number; userId: string; repeatDays?: number },
): Promise<StartRunResult> {
  const active = await executor.query(
    `SELECT id FROM flow_runs WHERE user_id = $1 AND flow_id = $2 AND status = 'active' LIMIT 1`,
    [input.userId, input.flowId],
  );
  if (active.rows.length > 0) {
    return { runId: String((active.rows[0] as { id: string | bigint }).id), skippedReason: 'active_exists' };
  }
  if (input.repeatDays && input.repeatDays > 0) {
    const recent = await executor.query(
      `SELECT id FROM flow_runs
       WHERE user_id = $1 AND flow_id = $2 AND started_at > now() - ($3 || ' days')::interval
       LIMIT 1`,
      [input.userId, input.flowId, String(input.repeatDays)],
    );
    if (recent.rows.length > 0) {
      return { runId: '', skippedReason: 'repeat_guard' };
    }
  }
  const inserted = await executor.query(
    `INSERT INTO flow_runs (flow_id, flow_version, user_id, status, current_step, context)
     VALUES ($1, $2, $3, 'active', 0, '{}'::jsonb) RETURNING id`,
    [input.flowId, input.flowVersion, input.userId],
  );
  return {
    runId: String((inserted.rows[0] as { id: string | bigint }).id),
    skippedReason: null,
  };
}

/** Продвинуть прогон: шаг выполнен, следующий назначен на nextFireAt. */
export async function advanceFlowRun(
  executor: SqlExecutor,
  runId: string,
  nextStep: number,
  nextFireAt: Date,
): Promise<void> {
  await executor.execute(
    `UPDATE flow_runs SET current_step = $2, context = jsonb_set(
       COALESCE(context, '{}'::jsonb), '{next_fire_at}', $3::jsonb, true)
     WHERE id = $1`,
    [runId, nextStep, JSON.stringify(nextFireAt.toISOString())],
  );
}

export async function finishFlowRun(
  executor: SqlExecutor,
  runId: string,
  status: 'completed' | 'cancelled' | 'failed',
): Promise<void> {
  await executor.execute(
    `UPDATE flow_runs SET status = $2, finished_at = now(), context = context - 'next_fire_at' WHERE id = $1`,
    [runId, status],
  );
}

/** Существует ли завершённый/любой прогон флоу у пользователя за N дней. */
export async function hasRunWithinDays(
  executor: SqlExecutor,
  input: { userId: string; flowId: string; days: number },
): Promise<boolean> {
  const result = await executor.query(
    `SELECT 1 FROM flow_runs
     WHERE user_id = $1 AND flow_id = $2 AND started_at > now() - ($3 || ' days')::interval
     LIMIT 1`,
    [input.userId, input.flowId, String(input.days)],
  );
  return result.rows.length > 0;
}

/** Определение флоу по id (прогон привязан к своей версии, §13.1). */
export async function getFlowDefinitionById(
  executor: SqlExecutor,
  flowId: string,
): Promise<{ code: string; version: number; definition: Record<string, unknown> } | null> {
  const result = await executor.query(
    `SELECT code, version, definition FROM automation_flows WHERE id = $1`,
    [flowId],
  );
  const row = result.rows[0] as
    | { code: string; version: number; definition: Record<string, unknown> }
    | undefined;
  return row ?? null;
}
