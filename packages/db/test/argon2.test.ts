import { describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS, hashPassword, verifyPassword } from '../src/argon2.js';

describe('argon2id (OWASP: m=19456, t=2, p=1)', () => {
  it('параметры зафиксированы константой', () => {
    expect(ARGON2_OPTIONS.memoryCost).toBe(19456);
    expect(ARGON2_OPTIONS.timeCost).toBe(2);
    expect(ARGON2_OPTIONS.parallelism).toBe(1);
  });

  it('roundtrip: verify(hash(p), p) === true', async () => {
    const hashValue = await hashPassword('correct horse battery staple');
    // формат argon2: $argon2id$...
    expect(hashValue.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hashValue, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('неверный пароль отклоняется', async () => {
    const hashValue = await hashPassword('right-password-1');
    await expect(verifyPassword(hashValue, 'wrong-password-1')).resolves.toBe(false);
  });

  it('разные пароли → разные хэши (соль)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });
});
