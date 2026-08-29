/**
 * Lockout неудачных входов (PRD §22): 5 попыток / 15 минут на email.
 * Счётчик-хранилище абстрагировано (redis / memory для тестов).
 */
export interface CounterStore {
  incr(key: string, windowSeconds: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

/** ioredis-совместимый структурный тип (ослаблен для совместимости). */
interface RedisLike {
  incr(key: string): Promise<number>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number, mode: 'NX'): Promise<unknown>;
}

export function createRedisCounterStore(redis: RedisLike): CounterStore {
  return {
    async incr(key, windowSeconds) {
      const value = await redis.incr(key);
      if (value === 1) await redis.expire(key, windowSeconds, 'NX');
      return value;
    },
    async get(key) {
      return Number(await redis.get(key)) || 0;
    },
    async reset(key) {
      await redis.del(key);
    },
  };
}

export function createMemoryCounterStore(): CounterStore {
  const store = new Map<string, number>();
  return {
    async incr(key) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async get(key) {
      return store.get(key) ?? 0;
    },
    async reset(key) {
      store.delete(key);
    },
  };
}

export const LOCKOUT_LIMIT = 5;
export const LOCKOUT_WINDOW_SEC = 15 * 60;

export function lockoutKey(email: string): string {
  return `tas:lock:${email}`;
}

export async function isLockedOut(store: CounterStore, email: string): Promise<boolean> {
  return (await store.get(lockoutKey(email))) >= LOCKOUT_LIMIT;
}

export async function registerFailedAttempt(store: CounterStore, email: string): Promise<number> {
  return store.incr(lockoutKey(email), LOCKOUT_WINDOW_SEC);
}

export async function resetLockout(store: CounterStore, email: string): Promise<void> {
  await store.reset(lockoutKey(email));
}
