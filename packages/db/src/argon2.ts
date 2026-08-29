import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id с параметрами OWASP (утверждено владельцем, M2):
 * m=19456 KiB (19 MiB), t=2, p=1.
 * Константа — единая точка изменения параметров.
 *
 * Примечание: Algorithm у @node-rs/argon2 — ambient const enum,
 * при verbatimModuleSyntax его нельзя импортировать как значение,
 * поэтому используется числовой литерал 2 (=== Algorithm.Argon2id).
 */
export const ARGON2_OPTIONS = {
  algorithm: 2, // Algorithm.Argon2id
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  return verify(hashValue, password);
}
