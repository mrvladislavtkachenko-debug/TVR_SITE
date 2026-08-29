import { AppError } from '@tas/shared';
import type { SqlExecutor } from './sql.js';

/**
 * Контентные единицы (pins) — сервисный слой с проверкой роли (RBAC дублируется
 * на роутере и здесь — защита в глубину). Переходы статусов валидируются.
 */

export type AdminRole = 'owner' | 'editor' | 'viewer';

export function assertRole(role: AdminRole, min: 'viewer' | 'editor' | 'owner'): void {
  const weight: Record<AdminRole, number> = { viewer: 1, editor: 2, owner: 3 };
  if (weight[role] < weight[min]) {
    throw new AppError('FORBIDDEN', `Requires ${min} role or higher`);
  }
}

export type PinStatus = 'idea' | 'approved' | 'scheduled' | 'published' | 'paused';

/** Допустимые переходы статусов контент-очереди. */
const PIN_TRANSITIONS: Record<PinStatus, PinStatus[]> = {
  idea: ['approved'],
  approved: ['scheduled'],
  scheduled: ['published'],
  published: ['paused'],
  paused: ['published'],
};

export interface PinRow {
  id: string;
  cluster_id: string;
  keyword_id: string | null;
  campaign_id: string | null;
  title: string;
  description: string | null;
  status: PinStatus;
  pin_id_pinterest: string | null;
  board: string | null;
  created_at: string;
}

const COLS =
  'id, cluster_id, keyword_id, campaign_id, title, description, status, pin_id_pinterest, board, created_at';

function normalize(row: Record<string, unknown>): PinRow {
  return {
    id: String(row.id),
    cluster_id: String(row.cluster_id),
    keyword_id: row.keyword_id === null ? null : String(row.keyword_id),
    campaign_id: row.campaign_id === null ? null : String(row.campaign_id),
    title: String(row.title),
    description: (row.description as string | null) ?? null,
    status: row.status as PinStatus,
    pin_id_pinterest: (row.pin_id_pinterest as string | null) ?? null,
    board: (row.board as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

export async function listPins(
  executor: SqlExecutor,
  opts: { status?: PinStatus; clusterId?: string; limit?: number },
): Promise<PinRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    params.push(opts.status);
    conditions.push(`status = $${params.length}::"PinStatus"`);
  }
  if (opts.clusterId) {
    params.push(opts.clusterId);
    conditions.push(`cluster_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(opts.limit ?? 50, 200));
  const result = await executor.query(
    `SELECT ${COLS} FROM pins ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((r) => normalize(r as Record<string, unknown>));
}

export async function createPin(
  executor: SqlExecutor,
  actor: { id: string; role: AdminRole },
  input: { clusterId: string; keywordId?: string | null; campaignId?: string | null; title: string; description?: string | null },
): Promise<PinRow> {
  assertRole(actor.role, 'editor');
  const result = await executor.query(
    `INSERT INTO pins (cluster_id, keyword_id, campaign_id, title, description, status)
     VALUES ($1, $2, $3, $4, $5, 'idea')
     RETURNING ${COLS}`,
    [input.clusterId, input.keywordId ?? null, input.campaignId ?? null, input.title, input.description ?? null],
  );
  return normalize(result.rows[0] as Record<string, unknown>);
}

export async function setPinStatus(
  executor: SqlExecutor,
  actor: { id: string; role: AdminRole },
  pinId: string,
  next: PinStatus,
): Promise<PinRow> {
  assertRole(actor.role, 'editor');
  const current = await executor.query(`SELECT ${COLS} FROM pins WHERE id = $1`, [pinId]);
  const row = current.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'Pin not found');
  const from = row.status as PinStatus;
  if (from === next) return normalize(row);
  const allowed = PIN_TRANSITIONS[from] ?? [];
  if (!allowed.includes(next)) {
    throw new AppError('UNPROCESSABLE', `Invalid status transition ${from} → ${next}`);
  }
  const updated = await executor.query(
    `UPDATE pins SET status = $1::"PinStatus", published_at = CASE WHEN $1 = 'published' THEN now() ELSE published_at END
     WHERE id = $2 RETURNING ${COLS}`,
    [next, pinId],
  );
  return normalize(updated.rows[0] as Record<string, unknown>);
}
