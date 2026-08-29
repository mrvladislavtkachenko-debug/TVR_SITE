import { describe, expect, it } from 'vitest';
import {
  adminSeedEnvSchema,
  apiEnvSchema,
  baseEnvSchema,
  botEnvSchema,
  dbEnvSchema,
  parseEnv,
  workerEnvSchema,
  type BaseEnv,
} from '../src/index.js';

const validBase: Record<string, string> = {
  NODE_ENV: 'development',
  PUBLIC_BASE_URL: 'https://tvrs.io',
  DATABASE_URL: 'postgresql://tas:tas_dev@localhost:5432/tas',
  REDIS_URL: 'redis://localhost:6379',
  TELEGRAM_BOT_TOKEN: '123456:ABC-DEF_fake_token_for_tests',
  LEAD_MAGNET_URL: 'https://files.example.com/lm.pdf',
  TELEGRAM_WEBHOOK_SECRET: '0123456789abcdef0123456789abcdef',
  TELEGRAM_BOT_USERNAME: 'TASbot',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'tas-files',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  LLM_API_BASE: 'https://api.openai.com/v1',
  LLM_API_KEY: 'sk-test',
  LLM_MODEL: 'gpt-4o-mini',
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  ENCRYPTION_KEY: 'base64key_with_at_least_32_characters==',
  IP_HASH_SALT: 'iphash-salt-0123456789ab',
};

describe('baseEnvSchema', () => {
  it('парсит валидный env и проставляет дефолты', () => {
    const env = parseEnv(baseEnvSchema, validBase);
    expect(env.ATTRIBUTION_TOKEN_PREFIX).toBe('t1');
    expect(env.NANOID_LEN).toBe(10);
    expect(env.SENDER_RATE_PER_SEC).toBe(25);
    expect(env.DAILY_MSG_CAP_PER_USER).toBe(1);
    // Э9
    expect(env.STAR_USD_RATE).toBe(0.013);
    // Э6
    expect(env.ENCRYPTION_KEY.length).toBeGreaterThanOrEqual(32);
  });

  it('требует ENCRYPTION_KEY ≥32 символов (Э6)', () => {
    const res = baseEnvSchema.safeParse({ ...validBase, ENCRYPTION_KEY: 'short' });
    expect(res.success).toBe(false);
  });

  it('отклоняет плохой DATABASE_URL', () => {
    const res = baseEnvSchema.safeParse({ ...validBase, DATABASE_URL: 'not-a-url' });
    expect(res.success).toBe(false);
  });

  it('отклоняет bot username с @', () => {
    const res = baseEnvSchema.safeParse({ ...validBase, TELEGRAM_BOT_USERNAME: '@TASbot' });
    expect(res.success).toBe(false);
  });

  it('parseEnv выводит список всех проблем сразу', () => {
    const broken = { ...validBase };
    delete broken.DATABASE_URL;
    delete broken.JWT_SECRET;
    expect(() => parseEnv(baseEnvSchema, broken)).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });

  it('пустая строка = unset: опциональные не падают, обязательные дают Required', () => {
    const withBlanks = {
      ...validBase,
      SENTRY_DSN: '', // опциональное: пусто → не задано
      BACKUP_S3_BUCKET: '   ',
      LLM_MODEL: '', // обязательное: пусто → Required
    };
    expect(() => parseEnv(baseEnvSchema, withBlanks)).toThrow(/LLM_MODEL/);
    const ok = parseEnv(baseEnvSchema, { ...withBlanks, LLM_MODEL: 'gpt-4o-mini' });
    expect(ok.SENTRY_DSN).toBeUndefined();
    expect(ok.BACKUP_S3_BUCKET).toBeUndefined();
  });
});

describe('пер-апп расширения', () => {
  it('apiEnvSchema: APP_PORT дефолт 4000, валидируется', () => {
    const env = parseEnv(apiEnvSchema, validBase);
    expect(env.APP_PORT).toBe(4000);
    const res = apiEnvSchema.safeParse({ ...validBase, APP_PORT: 'not-a-port' });
    expect(res.success).toBe(false);
  });

  it('botEnvSchema: BOT_PORT дефолт 4100 и есть ТОЛЬКО здесь (Э5/AN-10)', () => {
    const env = parseEnv(botEnvSchema, validBase);
    expect(env.BOT_PORT).toBe(4100);
    // в base/api/worker BOT_PORT отсутствует в схеме
    const baseParsed: BaseEnv = parseEnv(baseEnvSchema, { ...validBase, BOT_PORT: '4100' });
    expect('BOT_PORT' in baseParsed).toBe(false);
    const res = botEnvSchema.safeParse({ ...validBase, BOT_PORT: 99999 });
    expect(res.success).toBe(false);
  });

  it('workerEnvSchema = base без портов', () => {
    const env = parseEnv(workerEnvSchema, validBase);
    expect('APP_PORT' in env).toBe(false);
    expect('BOT_PORT' in env).toBe(false);
  });

  it('dbEnvSchema: только DATABASE_URL/NODE_ENV — seed не требует Telegram/S3/LLM (M2)', () => {
    const env = parseEnv(dbEnvSchema, {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://tas:tas_dev@localhost:5432/tas',
    });
    expect('TELEGRAM_BOT_TOKEN' in env).toBe(false);
    expect('S3_BUCKET' in env).toBe(false);
    expect('LLM_API_KEY' in env).toBe(false);
  });

  it('adminSeedEnvSchema: dbEnvSchema + ENCRYPTION_KEY ≥32', () => {
    const ok = adminSeedEnvSchema.safeParse({
      DATABASE_URL: 'postgresql://tas:tas_dev@localhost:5432/tas',
      ENCRYPTION_KEY: 'base64key_with_at_least_32_characters==',
    });
    expect(ok.success).toBe(true);
    const short = adminSeedEnvSchema.safeParse({
      DATABASE_URL: 'postgresql://tas:tas_dev@localhost:5432/tas',
      ENCRYPTION_KEY: 'short',
    });
    expect(short.success).toBe(false);
  });
});
