import { z } from 'zod';
import type { SqlExecutor } from '@tas/db/services';
import type { TgButton } from './telegram.js';

/**
 * Шаблоны сообщений (§39.7: все ответы бота — из message_templates).
 * Рендер {{var}}; кнопки — [{text, type:'callback', data}] (как в seed флоу).
 */

export interface BotTemplate {
  body: string;
  buttons: TgButton[] | null;
}

export interface TemplateStore {
  get(code: string): Promise<BotTemplate | null>;
}

const templateButtonSchema = z.object({
  text: z.string().min(1).max(64),
  type: z.literal('callback'),
  data: z.string().min(1).max(64), // callback_data ≤64 байта (§39.7)
});

/** Валидация кнопок шаблона; некорректный шаблон → null (бот ответит без кнопок). */
export function templateButtons(raw: unknown): TgButton[] | null {
  if (raw === null || raw === undefined) return null;
  const parsed = z.array(templateButtonSchema).safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) return null;
  return parsed.data.map((b) => ({ text: b.text, callbackData: b.data }));
}

/** Подстановка {{var}}; отсутствующие переменные → пустая строка. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

/** Загрузчик из БД с in-memory кэшем (TTL 60s) — копирайт меняется редко. */
export function createDbTemplateStore(
  executor: SqlExecutor,
  locale = 'en',
  ttlMs = 60_000,
): TemplateStore {
  const cache = new Map<string, { at: number; tpl: BotTemplate | null }>();
  return {
    async get(code) {
      const hit = cache.get(code);
      if (hit && Date.now() - hit.at < ttlMs) return hit.tpl;
      const result = await executor.query(
        `SELECT body, buttons FROM message_templates
         WHERE code = $1 AND locale = $2 AND is_active
         ORDER BY version DESC LIMIT 1`,
        [code, locale],
      );
      const row = result.rows[0] as { body: string; buttons: unknown } | undefined;
      const tpl: BotTemplate | null = row
        ? { body: row.body, buttons: templateButtons(row.buttons) }
        : null;
      cache.set(code, { at: Date.now(), tpl });
      return tpl;
    },
  };
}
