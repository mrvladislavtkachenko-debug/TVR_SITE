import { describe, expect, it } from 'vitest';
import { renderTemplate, templateButtons } from '@tas/db/services';
import { CALLBACK } from '../src/fsm.js';
import { messageLengthBucket, telegramStartPropsSchema } from '@tas/shared';

describe('templates (§39.7)', () => {
  it('рендер {{var}} и отсутствие переменной → пустая строка', () => {
    expect(renderTemplate('Привет, {{first_name}}!', { first_name: 'Anna' })).toBe('Привет, Anna!');
    expect(renderTemplate('Привет, {{ first_name }}!', { first_name: 'Anna' })).toBe('Привет, Anna!');
    expect(renderTemplate('x {{missing}} y', {})).toBe('x  y');
  });

  it('кнопки шаблона валидируются; некорректные → null', () => {
    expect(templateButtons([{ text: 'ok', type: 'callback', data: 'q1:S1' }])).toEqual([
      { text: 'ok', callbackData: 'q1:S1' },
    ]);
    expect(templateButtons(null)).toBeNull();
    expect(templateButtons([{ text: 'x', type: 'link', data: 'y' }])).toBeNull();
    // callback_data >64 байт запрещён (§39.7)
    expect(templateButtons([{ text: 'x', type: 'callback', data: 'a'.repeat(65) }])).toBeNull();
  });

  it('все callback_data бота ≤64 байт (платформенное ограничение)', () => {
    for (const value of Object.values(CALLBACK)) {
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('event-схемы (§16.2)', () => {
  it('messageLengthBucket: границы корзин', () => {
    expect(messageLengthBucket(0)).toBe('empty');
    expect(messageLengthBucket(1)).toBe('short');
    expect(messageLengthBucket(64)).toBe('short');
    expect(messageLengthBucket(65)).toBe('medium');
    expect(messageLengthBucket(256)).toBe('medium');
    expect(messageLengthBucket(257)).toBe('long');
  });

  it('telegram_start properties: статус payload — enum', () => {
    expect(
      telegramStartPropsSchema.safeParse({
        start_payload: 't1aB9xK2mQz',
        payload_status: 'ok',
        is_returning: false,
        source_hint: 'tracked',
      }).success,
    ).toBe(true);
    expect(
      telegramStartPropsSchema.safeParse({
        start_payload: null,
        payload_status: 'levenshtein',
        is_returning: false,
        source_hint: 'unknown',
      }).success,
    ).toBe(false);
  });
});
