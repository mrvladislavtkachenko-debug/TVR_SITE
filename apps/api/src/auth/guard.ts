import type { FastifyRequest } from 'fastify';
import { AppError } from '@tas/shared';
import { verifyJwt } from './jwt.js';

/**
 * RBAC-гарды (PRD §22): проверка на роутере; сервисный слой дублирует
 * (assertRole в @tas/db/services/pins) — защита в глубину.
 */

export interface AdminPrincipal {
  id: string;
  role: 'owner' | 'editor' | 'viewer';
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminPrincipal;
  }
}

const ROLE_WEIGHT = { viewer: 1, editor: 2, owner: 3 } as const;
export type MinRole = keyof typeof ROLE_WEIGHT;

function parseBearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Missing bearer token');
  }
  return header.slice('Bearer '.length);
}

export function authenticate(request: FastifyRequest, jwtSecret: string): AdminPrincipal {
  let claims;
  try {
    claims = verifyJwt(parseBearer(request.headers.authorization), jwtSecret);
  } catch {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired token');
  }
  const principal: AdminPrincipal = { id: claims.sub, role: claims.role, email: claims.email };
  request.admin = principal;
  return principal;
}

/** preHandler: требует валидный JWT и роль не ниже min. */
export function requireRole(jwtSecret: string, min: MinRole) {
  return async (request: FastifyRequest): Promise<void> => {
    const principal = authenticate(request, jwtSecret);
    if (ROLE_WEIGHT[principal.role] < ROLE_WEIGHT[min]) {
      throw new AppError('FORBIDDEN', `Requires ${min} role or higher`);
    }
  };
}
