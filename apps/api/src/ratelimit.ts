/**
 * Fixed-window rate limit на Redis (INCR + EXPIRE NX).
 * Для публичных эндпоинтов: 60 req/60s на IP (PRD §22).
 * Счётчик абстрагирован интерфейсом — тесты на in-memory реализации.
 */
export interface RateCounter {
  incr(key: string, windowSeconds: number): Promise<number>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export function createRedisRateCounter(redis: {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number, mode: 'NX'): Promise<unknown>;
}): RateCounter {
  return {
    async incr(key, windowSeconds) {
      const value = await redis.incr(key);
      if (value === 1) {
        await redis.expire(key, windowSeconds, 'NX');
      }
      return value;
    },
  };
}

export function createMemoryRateCounter(): RateCounter & { dump(): Map<string, number> } {
  const store = new Map<string, number>();
  return {
    async incr(key) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    dump() {
      return store;
    },
  };
}

export async function checkRateLimit(
  counter: RateCounter,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const count = await counter.incr(key, windowSeconds);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}
