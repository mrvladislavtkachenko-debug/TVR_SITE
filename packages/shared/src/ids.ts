/**
 * Tracking-токен атрибуции (PRD §10.2, Э-инвариант: формат не менять).
 * Формат: {PREFIX}{NANOID10}, например t1aB9xK2mQz — 12 символов,
 * алфавит base64url [A-Za-z0-9_-] — совместим с ограничением Telegram
 * start-payload (1–64 симв., A-Za-z0-9_-).
 */
export interface TokenFormat {
  prefix: string;
  length: number;
}

/** Строгая проверка токена по формату (prefix из env, длина nanoid из env). */
export function trackingTokenRegex({ prefix, length }: TokenFormat): RegExp {
  // prefix валидируется env-схемой: [A-Za-z0-9_-]{1,8}; length — int 8..16
  return new RegExp(`^${prefix}[A-Za-z0-9_-]{${length}}$`);
}

export function isTrackingToken(
  value: string,
  format: TokenFormat = { prefix: 't1', length: 10 },
): boolean {
  return trackingTokenRegex(format).test(value);
}

/** Deep link Telegram: https://t.me/{bot}?start={token} */
export function telegramDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${token}`;
}
