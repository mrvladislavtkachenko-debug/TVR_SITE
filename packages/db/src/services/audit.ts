import type { SqlExecutor } from './sql.js';

/**
 * Audit log (PRD §22/§15.4): каждое действие админа/AI/системы над сущностями.
 * Append-only; запись не должна ломать основной путь — вызывается после
 * основного действия и вне транзакции с ним (осознанно: аудит важен, но
 * не должен откатывать бизнес-операцию; расхождение ловит мониторинг).
 */
export interface AuditEntry {
  actorType: 'admin' | 'system' | 'ai';
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function writeAudit(executor: SqlExecutor, entry: AuditEntry): Promise<void> {
  await executor.execute(
    `INSERT INTO audit_logs (actor_type, actor_id, action, entity, entity_id, meta)
     VALUES ($1::"ActorType", $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      JSON.stringify(entry.meta ?? {}),
    ],
  );
}
