import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@tas/shared';
import { verifyPassword } from '@tas/db';
import {
  getAdminByEmail,
  updateLastLogin,
  verifyTotp,
  writeAudit,
  type SqlExecutor,
} from '@tas/db/services';
import type { CounterStore } from '../../auth/lockout.js';
import {
  LOCKOUT_LIMIT,
  LOCKOUT_WINDOW_SEC,
  isLockedOut,
  registerFailedAttempt,
  resetLockout,
} from '../../auth/lockout.js';
import { signJwt } from '../../auth/jwt.js';
import type { RateCounter } from '../../ratelimit.js';
import { checkRateLimit } from '../../ratelimit.js';

/**
 * POST /api/v1/admin/auth/login — защита (PRD §22):
 * 1) rate limit по IP: 20/15 мин; 2) lockout по email: 5 неудач/15 мин;
 * 3) argon2id пароль; 4) TOTP (RFC 6238, окно ±1).
 * Успех → JWT (HS256, 15 мин) + audit admin_login. Неудачи → единый 401
 * 'Invalid credentials' (без enumerate), audit admin_login_failed.
 */

const loginBodySchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  password: z.string().min(8).max(128),
  totp: z.string().regex(/^\d{6}$/),
});

export interface LoginRouteDeps {
  executor: SqlExecutor;
  lockoutStore: CounterStore;
  loginRateCounter: RateCounter;
  jwtSecret: string;
  encryptionKey: string;
  tokenTtlSeconds?: number;
}

export function registerLoginRoute(app: FastifyInstance, deps: LoginRouteDeps): void {
  const ttl = deps.tokenTtlSeconds ?? 900;

  app.post('/api/v1/admin/auth/login', async (request, reply) => {
    const ip = request.ip ?? '0.0.0.0';
    const rl = await checkRateLimit(deps.loginRateCounter, `tas:rl:login:${ip}`, 20, LOCKOUT_WINDOW_SEC);
    if (!rl.allowed) {
      reply.header('Retry-After', String(LOCKOUT_WINDOW_SEC));
      throw new AppError('RATE_LIMITED', 'Too many login attempts');
    }

    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid login payload', parsed.error.issues);
    }
    const { email, password, totp } = parsed.data;

    if (await isLockedOut(deps.lockoutStore, email)) {
      throw new AppError('RATE_LIMITED', 'Account locked, try again in 15 minutes');
    }

    const admin = await getAdminByEmail(deps.executor, email);
    const invalid = new AppError('UNAUTHORIZED', 'Invalid credentials');

    if (!admin) throw invalid;

    const passwordOk = await verifyPassword(admin.password_hash, password);
    if (!passwordOk) {
      const attempts = await registerFailedAttempt(deps.lockoutStore, email);
      await writeAudit(deps.executor, {
        actorType: 'admin',
        actorId: admin.id,
        action: 'admin_login_failed',
        entity: 'admin_users',
        entityId: admin.id,
        meta: { reason: 'password', attempts },
      }).catch(() => undefined);
      if (attempts >= LOCKOUT_LIMIT) {
        throw new AppError('RATE_LIMITED', 'Account locked, try again in 15 minutes');
      }
      throw invalid;
    }

    const totpOk = verifyTotp(totp, admin.totp_secret_encrypted, deps.encryptionKey);
    if (!totpOk) {
      const attempts = await registerFailedAttempt(deps.lockoutStore, email);
      await writeAudit(deps.executor, {
        actorType: 'admin',
        actorId: admin.id,
        action: 'admin_login_failed',
        entity: 'admin_users',
        entityId: admin.id,
        meta: { reason: 'totp', attempts },
      }).catch(() => undefined);
      if (attempts >= LOCKOUT_LIMIT) {
        throw new AppError('RATE_LIMITED', 'Account locked, try again in 15 minutes');
      }
      throw invalid;
    }

    await resetLockout(deps.lockoutStore, email);
    await updateLastLogin(deps.executor, admin.id);
    await writeAudit(deps.executor, {
      actorType: 'admin',
      actorId: admin.id,
      action: 'admin_login',
      entity: 'admin_users',
      entityId: admin.id,
      meta: { ip },
    }).catch(() => undefined);

    const token = signJwt({ sub: admin.id, role: admin.role, email: admin.email }, deps.jwtSecret, ttl);
    reply.code(200);
    return { token, expiresIn: ttl };
  });
}
