import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Минимальный HS256 JWT (без внешних зависимостей — TD-007: осознанно;
 * алгоритм зафиксирован, exp обязателен, сравнение timing-safe).
 * Claims: sub (adminId), role, email; TTL 900s (15 мин, PRD §22).
 */

export interface JwtClaims {
  sub: string;
  role: 'owner' | 'editor' | 'viewer';
  email: string;
  exp: number; // epoch seconds
  iat: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Роли админов (§22 RBAC) — enum для валидации claims (TD-007, M6). */
const ADMIN_ROLES = ['owner', 'editor', 'viewer'] as const;

export function signJwt(claims: Omit<JwtClaims, 'exp' | 'iat'>, secret: string, ttlSeconds = 900): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [header, body, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('invalid signature');
  }

  let parsedHeader: { alg?: string };
  let claims: JwtClaims;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    throw new JwtError('invalid token payload');
  }
  if (parsedHeader.alg !== 'HS256') throw new JwtError('unexpected alg');
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new JwtError('token expired');
  }
  // TD-007 закрыт (M6, требование владельца): role валидируется против enum,
  // а не только typeof string — чужое значение не проходит в RBAC-веса
  if (
    typeof claims.sub !== 'string' ||
    !ADMIN_ROLES.includes(claims.role as (typeof ADMIN_ROLES)[number])
  ) {
    throw new JwtError('invalid claims');
  }
  return claims;
}
