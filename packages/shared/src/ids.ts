import { customAlphabet, urlAlphabet } from 'nanoid';

/**
 * Tracking-токен атрибуции (PRD §10.2, Э-инвариант: формат не менять).
 * Формат: {PREFIX}{NANOID10}, например t1aB9xK2mQz7 — 12 символов,
 * алфавит base64url [A-Za-z0-9_-] (nanoid urlAlphabet) — совместим с
 * ограничением Telegram start-payload (1–64 симв., A-Za-z0-9_-).
 */
export interface TokenFormat {
  prefix: string;
  length: number;
}

export const DEFAULT_TOKEN_FORMAT: TokenFormat = { prefix: 't1', length: 10 };

/** Строгая проверка токена по формату (prefix из env, длина nanoid из env). */
export function trackingTokenRegex({ prefix, length }: TokenFormat): RegExp {
  // prefix валидируется env-схемой: [A-Za-z0-9_-]{1,8}; length — int 8..16
  return new RegExp(`^${prefix}[A-Za-z0-9_-]{${length}}$`);
}

export function isTrackingToken(
  value: string,
  format: TokenFormat = DEFAULT_TOKEN_FORMAT,
): boolean {
  return trackingTokenRegex(format).test(value);
}

/** Сгенерировать токен в формате {prefix}{nanoid(length)}. */
export function generateTrackingToken(format: TokenFormat = DEFAULT_TOKEN_FORMAT): string {
  return `${format.prefix}${customAlphabet(urlAlphabet, format.length)()}`;
}

/**
 * Сгенерировать уникальный токен вне заданного множества (retry при коллизии).
 * Используется сервисом issueTrackingLink; здесь — чистая логика для тестов.
 */
export function generateTrackingTokenExcluding(
  existing: ReadonlySet<string>,
  format: TokenFormat = DEFAULT_TOKEN_FORMAT,
  maxAttempts = 8,
): string {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = generateTrackingToken(format);
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(
    `Не удалось сгенерировать уникальный tracking-токен за ${maxAttempts} попыток`,
  );
}

/** Deep link Telegram: https://t.me/{bot}?start={token} */
export function telegramDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${token}`;
}

/** Публичный URL tracking-ссылки: {PUBLIC_BASE_URL}/m/{slug}?t={token} */
export function publicTrackingUrl(
  publicBaseUrl: string,
  slug: string,
  token: string,
): string {
  return `${publicBaseUrl.replace(/\/$/, '')}/m/${slug}?t=${encodeURIComponent(token)}`;
}
