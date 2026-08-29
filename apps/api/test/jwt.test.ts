import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt, JwtError } from '../src/auth/jwt.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const claims = { sub: '7', role: 'owner' as const, email: 'owner@example.com' };

describe('HS256 JWT (без внешних зависимостей, TD-007)', () => {
  it('roundtrip: sign → verify возвращает claims', () => {
    const token = signJwt(claims, SECRET, 900);
    const parsed = verifyJwt(token, SECRET);
    expect(parsed.sub).toBe('7');
    expect(parsed.role).toBe('owner');
    expect(parsed.email).toBe('owner@example.com');
    expect(parsed.exp).toBeGreaterThan(parsed.iat);
  });

  it('формат: три части, HS256 в header', () => {
    const token = signJwt(claims, SECRET, 60);
    const [h] = token.split('.');
    expect(token.split('.').length).toBe(3);
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString()).alg).toBe('HS256');
  });

  it('неверный секрет → invalid signature', () => {
    const token = signJwt(claims, SECRET, 60);
    expect(() => verifyJwt(token, 'x'.repeat(32))).toThrow(JwtError);
  });

  it('подменённый payload → invalid signature', () => {
    const token = signJwt(claims, SECRET, 60);
    const [h, , s] = token.split('.');
    const evil = Buffer.from(JSON.stringify({ ...claims, role: 'owner', sub: '1' })).toString('base64url');
    expect(() => verifyJwt(`${h}.${evil}.${s}`, SECRET)).toThrow(/signature/);
  });

  it('просроченный → token expired', () => {
    const token = signJwt(claims, SECRET, -10);
    expect(() => verifyJwt(token, SECRET)).toThrow(/expired/);
  });

  it('alg=none подмена → rejected', () => {
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
    expect(() => verifyJwt(`${noneHeader}.${body}.x`, SECRET)).toThrow(JwtError);
  });

  it('мусор → malformed', () => {
    expect(() => verifyJwt('abc', SECRET)).toThrow(/malformed/);
    expect(() => verifyJwt('a.b.c.d', SECRET)).toThrow(/malformed/);
  });
});
