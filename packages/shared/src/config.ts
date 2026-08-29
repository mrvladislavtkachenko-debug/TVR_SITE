import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Env-контракты (PRD §39.14 + эррата Э6/Э9).
 * Базовая схема — общая для всех приложений; пер-апп расширения ниже.
 * BOT_PORT валидируется ТОЛЬКО в apps/bot (Э5/AN-10).
 */

const urlish = z.string().min(1).url();

/** Общие переменные для всех приложений TAS. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // URLs
  PUBLIC_BASE_URL: urlish,

  // Database / cache
  DATABASE_URL: urlish,
  REDIS_URL: urlish,

  // Telegram (§24.2)
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{4,64}$/, 'Telegram bot username: 4–64 символов A-Za-z0-9_'),

  // S3
  S3_ENDPOINT: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),

  // AI (OpenAI-совместимый адаптер, §39.11)
  LLM_API_BASE: urlish,
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),

  // Security
  JWT_SECRET: z.string().min(32, 'JWT_SECRET: минимум 32 символа'),
  JWT_TTL: z.string().default('15m'),
  /** Э6: AES-256-GCM ключ (openssl rand -base64 32) для TOTP-секретов. */
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY: минимум 32 символа'),

  // Attribution (формат токена менять нельзя — ссылки живут в опубликованных пинах)
  ATTRIBUTION_TOKEN_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,8}$/)
    .default('t1'),
  NANOID_LEN: z.coerce.number().int().min(8).max(16).default(10),

  // Limits (запас до 30 msg/s Telegram, §13.2)
  SENDER_RATE_PER_SEC: z.coerce.number().int().min(1).max(30).default(25),
  DAILY_MSG_CAP_PER_USER: z.coerce.number().int().min(0).default(1),

  // Economics (Э9)
  STAR_USD_RATE: z.coerce.number().positive().default(0.013),

  // Monitoring / backups (опционально)
  SENTRY_DSN: urlish.optional(),
  BACKUP_S3_BUCKET: z.string().min(1).optional(),

  // Pinterest (V1 — не используется в MVP)
  PINTEREST_ACCESS_TOKEN: z.string().optional(),
  PINTEREST_AD_ACCOUNT_ID: z.string().optional(),

  // Goals (пороги гипотезы Phase 2, §30.4)
  GOALS_ACTIVATION: z.coerce.number().min(0).max(1).default(0.4),
  GOALS_START_TO_CUSTOMER: z.coerce.number().min(0).max(1).default(0.025),
  GOALS_BLOCK_RATE: z.coerce.number().min(0).max(1).default(0.02),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** apps/api: Fastify :4000. */
export const apiEnvSchema = baseEnvSchema.extend({
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** apps/bot: отдельный Fastify :4100 (Э5, AN-10). */
export const botEnvSchema = baseEnvSchema.extend({
  BOT_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
});

export type BotEnv = z.infer<typeof botEnvSchema>;

/** apps/worker: BullMQ (M6). */
export const workerEnvSchema = baseEnvSchema;

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * packages/db + seed/CLI (утверждено владельцем, M2): только переменные БД.
 * Seed НЕ должен требовать Telegram/S3/LLM ключи — поэтому отдельная схема.
 */
export const dbEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: urlish,
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

/** seed:admin CLI — дополнительно требует ключ шифрования TOTP (Э6). */
export const adminSeedEnvSchema = dbEnvSchema.extend({
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY: минимум 32 символа'),
});

export type AdminSeedEnv = z.infer<typeof adminSeedEnvSchema>;

/**
 * Парсинг env со списком всех проблем сразу (не по одной).
 * Пустые строки и пробельные значения трактуются как «не задано» (unset):
 * опциональные поля с `SENTRY_DSN=` в .env не падают, обязательные
 * дают понятную ошибку «Required».
 * Бросает Error с человекочитаемым списком — приложение падает на старте.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  rawEnv: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string' && value.trim() === '') continue; // '' → unset
    raw[key] = value;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${where}: ${issue.message}`;
    });
    throw new Error(`Invalid environment (${result.error.issues.length} problem(s)):\n${lines.join('\n')}`);
  }
  return result.data;
}

/**
 * Подгрузка корневого .env (репозиторного) без переопределения уже
 * выставленных переменных. Ищет от cwd вверх до корня репо.
 */
export function loadRootEnv(startDir: string = process.cwd()): boolean {
  const candidates = [
    path.join(startDir, '.env'),
    path.join(startDir, '..', '.env'),
    path.join(startDir, '..', '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate); // не переопределяет существующий process.env
      return true;
    }
  }
  return false;
}
