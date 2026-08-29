/**
 * Idempotency-Key на mutations (PRD §19): ключ+ответ хранятся в Redis
 * (SET ... EX ... NX, 24h); повтор с тем же ключом возвращает сохранённый
 * ответ с заголовком Idempotency-Replayed: true.
 */
export interface IdempotencyStore {
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>; // true = записали
  get(key: string): Promise<string | null>;
}

/** ioredis-совместимый структурный тип: set(key, value, 'EX', ttl, 'NX'). */
interface RedisLike {
  set(key: string, value: string, expiryMode: 'EX', ttl: number, setMode: 'NX'): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function createRedisIdempotencyStore(redis: RedisLike): IdempotencyStore {
  return {
    async setNx(key, value, ttlSeconds) {
      return (await redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
    },
    async get(key) {
      return redis.get(key);
    },
  };
}

export function createMemoryIdempotencyStore(): IdempotencyStore & { dump(): Map<string, string> } {
  const store = new Map<string, string>();
  return {
    async setNx(key, value) {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    dump() {
      return store;
    },
  };
}

export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

export interface IdempotentResult {
  replayed: boolean;
  statusCode: number;
  body: unknown;
}

/**
 * Обёртка: если ключ указан и уже есть — вернуть сохранённый ответ (replayed);
 * иначе выполнить handler, сохранить и вернуть свежий ответ.
 */
export async function withIdempotency(
  store: IdempotencyStore,
  scope: string, // напр. `admin:{id}` — ключи не пересекаются между админами
  idempotencyKey: string | undefined,
  handler: () => Promise<{ statusCode: number; body: unknown }>,
): Promise<IdempotentResult> {
  if (!idempotencyKey) {
    const fresh = await handler();
    return { replayed: false, ...fresh };
  }
  const key = `tas:idem:${scope}:${idempotencyKey}`;
  const cached = await store.get(key);
  if (cached !== null) {
    const parsed = JSON.parse(cached) as { statusCode: number; body: unknown };
    return { replayed: true, ...parsed };
  }
  const fresh = await handler();
  const stored = JSON.stringify(fresh);
  const storedFirst = await store.setNx(key, stored, IDEMPOTENCY_TTL_SEC);
  if (!storedFirst) {
    // гонка: параллельный запрос записал первым — читаем его ответ
    const winner = await store.get(key);
    if (winner !== null) {
      const parsed = JSON.parse(winner) as { statusCode: number; body: unknown };
      return { replayed: true, ...parsed };
    }
  }
  return { replayed: false, ...fresh };
}
