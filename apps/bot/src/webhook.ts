import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@tas/shared';
import { insertNewUpdate, type SqlExecutor } from '@tas/db/services';
import type { UpdatePipeline } from './pipeline.js';
import type { Update } from 'grammy/types';

/**
 * Webhook Telegram (§22, §28.9/28.12): проверка секретного токена
 * (constant-time), запись сырого update с идемпотентностью по update_id,
 * мгновенный ACK — обработка уходит в фон (UpdatePipeline).
 * DB недоступна → 500: Telegram повторит доставку (§28.14).
 */

const updateIdSchema = z.object({ update_id: z.number().int().positive() }).passthrough();

export interface WebhookDeps {
  executor: SqlExecutor;
  /** Ожидаемое значение X-Telegram-Bot-Api-Secret-Token. */
  secret: string;
  pipeline: UpdatePipeline;
}

/** Сравнение через SHA-256-дайджесты: постоянное время и без утечки длины. */
export function secretTokenEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function registerWebhookRoute(app: FastifyInstance, deps: WebhookDeps): void {
  app.post('/webhook/telegram', async (request, reply) => {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided !== 'string' || !secretTokenEqual(provided, deps.secret)) {
      // reject прочих (§22)
      throw new AppError('UNAUTHORIZED', 'invalid webhook secret token');
    }
    const parsed = updateIdSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'malformed telegram update');
    }
    const body = request.body as Update;
    const row = await insertNewUpdate(deps.executor, String(body.update_id), body);
    if (!row) {
      // §28.9: повторная доставка Telegram — пропускаем, ACK 200
      return reply.code(200).send({ ok: true, duplicate: true });
    }
    deps.pipeline.submit(body, row.id);
    return reply.code(200).send({ ok: true });
  });
}
