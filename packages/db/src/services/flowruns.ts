import type { SqlExecutor } from './sql.js';

/** flow_runs (M6 — интерпретатор; M5 использует только отмену: /stop, блокировка). */

export async function cancelActiveFlowRuns(executor: SqlExecutor, userId: string): Promise<number> {
  return executor.execute(
    `UPDATE flow_runs SET status = 'cancelled', finished_at = now()
     WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
}
