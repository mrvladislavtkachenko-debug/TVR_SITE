import { describe, expect, it } from 'vitest';
import {
  LOCKOUT_LIMIT,
  createMemoryCounterStore,
  isLockedOut,
  registerFailedAttempt,
  resetLockout,
} from '../src/auth/lockout.js';
import {
  createMemoryIdempotencyStore,
  withIdempotency,
} from '../src/idempotency.js';

describe('lockout (5×15мин, PRD §22)', () => {
  it('после 5 неудач — locked; reset снимает', async () => {
    const store = createMemoryCounterStore();
    for (let i = 1; i <= LOCKOUT_LIMIT; i++) {
      expect(await isLockedOut(store, 'a@b.c')).toBe(false);
      await registerFailedAttempt(store, 'a@b.c');
    }
    expect(await isLockedOut(store, 'a@b.c')).toBe(true);
    await resetLockout(store, 'a@b.c');
    expect(await isLockedOut(store, 'a@b.c')).toBe(false);
  });

  it('счётчики независимы по email', async () => {
    const store = createMemoryCounterStore();
    await registerFailedAttempt(store, 'a@b.c');
    expect(await isLockedOut(store, 'x@y.z')).toBe(false);
  });
});

describe('withIdempotency', () => {
  it('первый вызов выполняет handler, второй с тем же ключом — replay', async () => {
    const store = createMemoryIdempotencyStore();
    let executions = 0;
    const handler = async () => {
      executions += 1;
      return { statusCode: 201, body: { short_code: 't1abc' } };
    };
    const r1 = await withIdempotency(store, 'admin:1', 'key-1', handler);
    const r2 = await withIdempotency(store, 'admin:1', 'key-1', handler);
    expect(executions).toBe(1);
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    expect(r2.body).toEqual({ short_code: 't1abc' });
    expect(r2.statusCode).toBe(201);
  });

  it('без ключа — каждый вызов выполняет handler', async () => {
    const store = createMemoryIdempotencyStore();
    let executions = 0;
    const handler = async () => {
      executions += 1;
      return { statusCode: 201, body: {} };
    };
    await withIdempotency(store, 'admin:1', undefined, handler);
    await withIdempotency(store, 'admin:1', undefined, handler);
    expect(executions).toBe(2);
  });

  it('ключи разных scope не пересекаются', async () => {
    const store = createMemoryIdempotencyStore();
    let executions = 0;
    const handler = async () => {
      executions += 1;
      return { statusCode: 201, body: {} };
    };
    await withIdempotency(store, 'admin:1', 'k', handler);
    await withIdempotency(store, 'admin:2', 'k', handler);
    expect(executions).toBe(2);
  });
});
