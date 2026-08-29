/**
 * Минимальальный JSON-кэш в Redis (TTL). Используется для резолва
 * tracking_links (60s — контракт M3). Отрицательное кэширование —
 * значение literally 'null'.
 */
export interface KvCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Адаптер ioredis → KvCache (SET с EX). */
export function createRedisCache(redis: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}): KvCache {
  return {
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

export const TRACKING_LINK_TTL_SEC = 60;

export function trackingLinkCacheKey(token: string): string {
  return `tas:tl:${token}`;
}
