import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, baseEventSchema, eventNamesSet, isEventName } from '../src/index.js';

describe('EVENT_NAMES (§16.2)', () => {
  it('25 событий, без дубликатов', () => {
    expect(EVENT_NAMES.length).toBe(25);
    expect(new Set(EVENT_NAMES).size).toBe(25);
  });

  it('ключевые события воронки присутствуют (Э7: link_click → telegram_start)', () => {
    for (const name of ['link_click', 'bridge_view', 'telegram_click', 'telegram_start']) {
      expect(eventNamesSet.has(name)).toBe(true);
    }
  });

  it('isEventName различает известные/неизвестные', () => {
    expect(isEventName('purchase_completed')).toBe(true);
    expect(isEventName('not_an_event')).toBe(false);
  });
});

describe('baseEventSchema', () => {
  it('принимает минимальное событие', () => {
    const parsed = baseEventSchema.parse({ name: 'telegram_start' });
    expect(parsed.properties).toEqual({});
    expect(parsed.user_id).toBeUndefined();
  });

  it('отклоняет неизвестное имя события', () => {
    expect(baseEventSchema.safeParse({ name: 'random_event' }).success).toBe(false);
  });

  it('dedup_key ограничен 128 символами (Э8)', () => {
    const ok = baseEventSchema.safeParse({ name: 'link_click', dedup_key: 'x'.repeat(128) });
    const tooLong = baseEventSchema.safeParse({ name: 'link_click', dedup_key: 'x'.repeat(129) });
    expect(ok.success).toBe(true);
    expect(tooLong.success).toBe(false);
  });
});
