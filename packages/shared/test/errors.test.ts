import { describe, expect, it } from 'vitest';
import { AppError, errorEnvelope, statusForCode } from '../src/index.js';

describe('error envelope (§19)', () => {
  it('форма { error: { code, message, details? } }', () => {
    expect(errorEnvelope('NOT_FOUND', 'Route not found')).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
    expect(errorEnvelope('VALIDATION_ERROR', 'bad input', [{ path: 't' }])).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'bad input', details: [{ path: 't' }] },
    });
  });

  it('маппинг код → HTTP-статус', () => {
    expect(statusForCode('VALIDATION_ERROR')).toBe(400);
    expect(statusForCode('UNAUTHORIZED')).toBe(401);
    expect(statusForCode('FORBIDDEN')).toBe(403);
    expect(statusForCode('NOT_FOUND')).toBe(404);
    expect(statusForCode('CONFLICT')).toBe(409);
    expect(statusForCode('UNPROCESSABLE')).toBe(422);
    expect(statusForCode('RATE_LIMITED')).toBe(429);
    expect(statusForCode('INTERNAL')).toBe(500);
  });

  it('AppError несёт код и статус', () => {
    const err = new AppError('RATE_LIMITED', 'Too many requests');
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
  });
});
