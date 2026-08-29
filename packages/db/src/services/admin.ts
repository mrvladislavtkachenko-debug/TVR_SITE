import type { SqlExecutor } from './sql.js';

/** admin_users строка (пароль/TOTP приходят из БД как есть). */
export interface AdminUserRow {
  id: string;
  email: string;
  password_hash: string;
  totp_secret_encrypted: string;
  role: 'owner' | 'editor' | 'viewer';
  is_active: boolean;
}

const COLS = 'id, email, password_hash, totp_secret_encrypted, role, is_active';

export async function getAdminByEmail(
  executor: SqlExecutor,
  email: string,
): Promise<AdminUserRow | null> {
  const result = await executor.query(
    `SELECT ${COLS} FROM admin_users WHERE email = $1 AND is_active`,
    [email],
  );
  const row = result.rows[0] as AdminUserRow | undefined;
  if (!row) return null;
  return { ...row, id: String(row.id) };
}

export async function updateLastLogin(executor: SqlExecutor, adminId: string): Promise<void> {
  await executor.execute('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [adminId]);
}
