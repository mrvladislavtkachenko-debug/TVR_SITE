import { describe, expect, it } from 'vitest';
import {
  buildEventsInsertSql,
  ipHash,
  issueTrackingLink,
  resolveTrackingLink,
  trackingLinkCacheKey,
  TRACKING_LINK_TTL_SEC,
  type EventInsert,
  type KvCache,
  type SqlExecutor,
  type TrackingLinkRow,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Фейковые executor/cache для hermetic-тестов сервисов
// ---------------------------------------------------------------------------

function fakeExecutor(opts: {
  onInsert?: (token: string) => boolean; // false = конфликт (0 строк)
  linkByToken?: Map<string, TrackingLinkRow>;
  queries?: string[];
}): SqlExecutor {
  return {
    async query(sql, params) {
      opts.queries?.push(sql);
      if (sql.startsWith('INSERT INTO tracking_links')) {
        const token = String(params[0]);
        if (opts.onInsert?.(token) === false) return { rows: [], rowCount: 0 };
        const row: TrackingLinkRow = {
          id: '1',
          short_code: token,
          source_id: 'pinterest',
          campaign_id: null,
          cluster_id: null,
          keyword_id: null,
          pin_id: null,
          landing_slug: 'morning-checklist',
          creative_variant: 'A',
          landing_variant: 'A',
          placement: null,
        };
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('FROM tracking_links')) {
        const token = String(params[0]);
        const row = opts.linkByToken?.get(token);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async execute() {
      return 1;
    },
  };
}

function fakeCache(): KvCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async del(key) {
      store.delete(key);
    },
  };
}

const ROW: TrackingLinkRow = {
  id: '7',
  short_code: 't1aaaaaaaaaa',
  source_id: 'pinterest',
  campaign_id: '3',
  cluster_id: null,
  keyword_id: null,
  pin_id: '11',
  landing_slug: 'morning-checklist',
  creative_variant: 'A',
  landing_variant: null,
  placement: null,
};

// ---------------------------------------------------------------------------

describe('buildEventsInsertSql (Э8)', () => {
  it('батч из 2 событий: $1..$12 и ON CONFLICT DO NOTHING', () => {
    const events: EventInsert[] = [
      { name: 'link_click', userId: null, trackingLinkId: '7', properties: { a: 1 }, dedupKey: 'k1' },
      { name: 'bridge_view', trackingLinkId: null, properties: {}, dedupKey: 'k2' },
    ];
    const { sql, params } = buildEventsInsertSql(events);
    expect(sql).toContain('ON CONFLICT (dedup_key) DO NOTHING');
    expect(sql).toContain('($1,$2,$3,$4,$5::jsonb,$6),($7,$8,$9,$10,$11::jsonb,$12)');
    expect(params).toHaveLength(12);
    expect(params[0]).toBe('link_click');
    expect(params[4]).toBe('{"a":1}');
    expect(params[5]).toBe('k1');
    expect(params[10]).toBe('{}');
  });

  it('пустой батч → бросает', () => {
    expect(() => buildEventsInsertSql([])).toThrow();
  });
});

describe('ipHash (§23: сырой IP не хранится)', () => {
  it('64 hex-символа, детерминирован, salt-чувствителен', () => {
    const a = ipHash('1.2.3.4', 'salt1');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ipHash('1.2.3.4', 'salt1')).toBe(a);
    expect(ipHash('1.2.3.4', 'salt2')).not.toBe(a);
    expect(ipHash('1.2.3.5', 'salt1')).not.toBe(a);
  });
});

describe('resolveTrackingLink (кэш 60s)', () => {
  it('невалидный формат → null без запроса к БД и кэшу', async () => {
    const executor = fakeExecutor({ queries: [] });
    const cache = fakeCache();
    const result = await resolveTrackingLink({ executor, cache }, 'nope');
    expect(result).toBeNull();
    expect(cache.store.size).toBe(0);
  });

  it('cache miss → SELECT → запись в кэш → второй вызов без SELECT', async () => {
    const queries: string[] = [];
    const executor = fakeExecutor({ linkByToken: new Map([[ROW.short_code, ROW]]), queries });
    const cache = fakeCache();
    const first = await resolveTrackingLink({ executor, cache }, ROW.short_code);
    expect(first?.id).toBe('7');
    expect(queries.filter((q) => q.includes('FROM tracking_links'))).toHaveLength(1);
    const key = trackingLinkCacheKey(ROW.short_code);
    expect(cache.store.get(key)).toBe(JSON.stringify(ROW));

    const second = await resolveTrackingLink({ executor, cache }, ROW.short_code);
    expect(second?.id).toBe('7');
    expect(queries.filter((q) => q.includes('FROM tracking_links'))).toHaveLength(1); // из кэша
  });

  it('негативный кэш: unknown токен не дёргает БД повторно', async () => {
    const queries: string[] = [];
    const executor = fakeExecutor({ linkByToken: new Map(), queries });
    const cache = fakeCache();
    expect(await resolveTrackingLink({ executor, cache }, 't1zzzzzzzzzz')).toBeNull();
    expect(await resolveTrackingLink({ executor, cache }, 't1zzzzzzzzzz')).toBeNull();
    expect(queries.filter((q) => q.includes('FROM tracking_links'))).toHaveLength(1);
    expect(cache.store.get(trackingLinkCacheKey('t1zzzzzzzzzz'))).toBe('null');
  });

  it('TTL кэша = 60s (контракт M3)', () => {
    expect(TRACKING_LINK_TTL_SEC).toBe(60);
  });
});

describe('issueTrackingLink', () => {
  it('успех с первого раза: токен формата t1+10, кэш прогрет', async () => {
    const cache = fakeCache();
    const executor = fakeExecutor({});
    const row = await issueTrackingLink(
      { executor, cache },
      { sourceId: 'pinterest', landingSlug: 'x', pinId: '5' },
    );
    expect(row.short_code).toMatch(/^t1[A-Za-z0-9_-]{10}$/);
    expect(cache.store.get(trackingLinkCacheKey(row.short_code))).toBe(JSON.stringify(row));
  });

  it('коллизия → retry (INSERT возвращает 0 строк, затем успех)', async () => {
    let calls = 0;
    const executor = fakeExecutor({
      onInsert: () => {
        calls += 1;
        return calls >= 3; // первые 2 вставки «конфликтуют» (0 строк)
      },
    });
    const row = await issueTrackingLink({ executor }, { sourceId: 'pinterest' });
    expect(calls).toBe(3);
    expect(row.short_code).toMatch(/^t1/);
  });
});
