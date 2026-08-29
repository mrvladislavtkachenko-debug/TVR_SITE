import { describe, expect, it } from 'vitest';
import {
  generateTrackingToken,
  generateTrackingTokenExcluding,
  isTrackingToken,
  publicTrackingUrl,
  telegramDeepLink,
  trackingTokenRegex,
} from '../src/index.js';

describe('tracking token (§10.2)', () => {
  const format = { prefix: 't1', length: 10 };

  it('принимает валидный t1 + nanoid(10)', () => {
    expect(isTrackingToken('t1aB9xK2mQz7', format)).toBe(true); // 12 символов всего
  });

  it('генерация: формат t1+nanoid(10), base64url-алфавит, уникальность 500', () => {
    const generated = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const token = generateTrackingToken(format);
      expect(token).toMatch(/^t1[A-Za-z0-9_-]{10}$/);
      generated.add(token);
    }
    expect(generated.size).toBe(500);
  });

  it('generateTrackingTokenExcluding: исключает занятые; 0 попыток → бросает', () => {
    const first = generateTrackingToken({ prefix: 't9', length: 8 });
    const second = generateTrackingTokenExcluding(new Set([first]), { prefix: 't9', length: 8 });
    expect(second).not.toBe(first);
    expect(second).toMatch(/^t9[A-Za-z0-9_-]{8}$/);
    expect(() => generateTrackingTokenExcluding(new Set(['x']), { prefix: 't9', length: 8 }, 0)).toThrow();
  });

  it('publicTrackingUrl: {base}/m/{slug}?t={token}', () => {
    expect(publicTrackingUrl('https://tvrs.io/', 'morning-checklist', 't1aB9xK2mQz7')).toBe(
      'https://tvrs.io/m/morning-checklist?t=t1aB9xK2mQz7',
    );
  });

  it('отклоняет неверный префикс/длину/символы', () => {
    expect(isTrackingToken('x1aB9xK2mQz7', format)).toBe(false); // prefix
    expect(isTrackingToken('t1aB9xK2mQ', format)).toBe(false); // 8 симв. nanoid
    expect(isTrackingToken('t1aB9xK2mQz!', format)).toBe(false); // invalid char
  });

  it('итоговая длина ≤ 64 симв. start-payload Telegram (§24.2)', () => {
    const token = 't1aB9xK2mQz7';
    expect(token.length).toBeLessThanOrEqual(64);
  });

  it('кастомный формат из env', () => {
    const re = trackingTokenRegex({ prefix: 'p7', length: 8 });
    expect(re.test('p7abcdEFGH')).toBe(true);
    expect(re.test('p7abcdEFG')).toBe(false);
  });
});

describe('telegramDeepLink', () => {
  it('https://t.me/{bot}?start={token}', () => {
    expect(telegramDeepLink('TASbot', 't1aB9xK2mQz7')).toBe(
      'https://t.me/TASbot?start=t1aB9xK2mQz7',
    );
  });
});
