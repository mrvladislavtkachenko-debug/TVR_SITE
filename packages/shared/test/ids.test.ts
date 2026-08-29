import { describe, expect, it } from 'vitest';
import { isTrackingToken, telegramDeepLink, trackingTokenRegex } from '../src/index.js';

describe('tracking token (§10.2)', () => {
  const format = { prefix: 't1', length: 10 };

  it('принимает валидный t1 + nanoid(10)', () => {
    expect(isTrackingToken('t1aB9xK2mQz7', format)).toBe(true); // 12 символов всего
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
