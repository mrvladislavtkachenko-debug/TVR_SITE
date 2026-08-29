import { describe, expect, it } from 'vitest';
import {
  bridgeEventSchema,
  buildDedupKey,
  classifyUaClass,
  epochMinuteOf,
  linkClickPropertiesSchema,
  telegramClickPropertiesSchema,
} from '../src/index.js';

describe('classifyUaClass', () => {
  it('Pinterest in-app webview', () => {
    expect(classifyUaClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Pinterest/17.0')).toBe('pinterest_app');
  });
  it('боты и скрипты', () => {
    expect(classifyUaClass('curl/8.5.0')).toBe('bot');
    expect(classifyUaClass('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('bot');
  });
  it('мобильные/десктоп', () => {
    expect(classifyUaClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')).toBe('mobile');
    expect(classifyUaClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36')).toBe('desktop');
  });
  it('пустой/неясный → other', () => {
    expect(classifyUaClass(undefined)).toBe('other');
    expect(classifyUaClass('')).toBe('other');
    expect(classifyUaClass('weird-agent-xyz')).toBe('other');
  });
});

describe('per-event схемы (Э3: свойства переходов)', () => {
  const token = 't1aB9xK2mQz7';
  const slug = 'morning-checklist';

  it('link_click принимает полный набор', () => {
    expect(
      linkClickPropertiesSchema.safeParse({
        slug,
        token,
        referer_host: 'pinterest.com',
        ip_hash: 'a'.repeat(64),
        ua_class: 'pinterest_app',
        session_id: 'bsid1234567890',
      }).success,
    ).toBe(true);
  });

  it('ip_hash строго 64 символа', () => {
    expect(
      linkClickPropertiesSchema.safeParse({ slug, token, ip_hash: 'short' }).success,
    ).toBe(false);
  });

  it('telegram_click — только slug/token/session_id', () => {
    expect(
      telegramClickPropertiesSchema.safeParse({ slug, token, session_id: 'bsid1234567890' })
        .success,
    ).toBe(true);
    expect(telegramClickPropertiesSchema.safeParse({ slug }).success).toBe(false);
  });

  it('bridgeEventSchema: discriminatedUnion по name', () => {
    expect(
      bridgeEventSchema.safeParse({ name: 'bridge_view', properties: { slug, token } }).success,
    ).toBe(true);
    expect(
      bridgeEventSchema.safeParse({ name: 'purchase_completed', properties: { slug, token } })
        .success,
    ).toBe(false);
  });
});

describe('dedup_key (Э8)', () => {
  it('формат name:token:bucket:minute, ≤128', () => {
    const key = buildDedupKey('link_click', 't1aB9xK2mQz7', 'session123456', 30000000);
    expect(key).toBe('link_click:t1aB9xK2mQz7:session123456:30000000');
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it('разные минуты → разные ключи', () => {
    expect(buildDedupKey('e', 't1aB9xK2mQz7', 'b', 100)).not.toBe(
      buildDedupKey('e', 't1aB9xK2mQz7', 'b', 101),
    );
  });

  it('переполнение → бросает', () => {
    expect(() => buildDedupKey('e', 'x'.repeat(100), 'y'.repeat(30), 1)).toThrow();
  });

  it('epochMinuteOf — минутный бакет', () => {
    expect(epochMinuteOf(new Date('2026-08-29T12:00:59Z'))).toBe(
      epochMinuteOf(new Date('2026-08-29T12:00:01Z')),
    );
  });
});
