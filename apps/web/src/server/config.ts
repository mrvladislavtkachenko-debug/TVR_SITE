import { baseEnvSchema, loadRootEnv, parseEnv, type TokenFormat } from '@tas/shared';

/**
 * Конфиг веб-сервера (bridge рендерится на сервере). Ленивый разовый парсинг:
 * build не требует env, первый запрос — валидирует (как api/bot на старте).
 */
export interface WebServerConfig {
  databaseUrl: string;
  redisUrl: string;
  botUsername: string;
  encryptionKey: string;
  ipHashSalt: string;
  tokenFormat: TokenFormat;
}

let cached: WebServerConfig | undefined;

export function getServerConfig(): WebServerConfig {
  if (!cached) {
    loadRootEnv();
    const env = parseEnv(baseEnvSchema);
    cached = {
      databaseUrl: env.DATABASE_URL,
      redisUrl: env.REDIS_URL,
      botUsername: env.TELEGRAM_BOT_USERNAME,
      encryptionKey: env.ENCRYPTION_KEY,
      ipHashSalt: env.IP_HASH_SALT,
      tokenFormat: { prefix: env.ATTRIBUTION_TOKEN_PREFIX, length: env.NANOID_LEN },
    };
  }
  return cached;
}
