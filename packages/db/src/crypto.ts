import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM для секретов at-rest (Э6: TOTP-секреты admin_users).
 * Формат шифротекста: v1.{iv}.{tag}.{ciphertext} — все части base64url.
 * Ключ: ENCRYPTION_KEY — base64 32 байта (openssl rand -base64 32) или
 * сырая строка ≥32 символов (нормализуется через SHA-256).
 */

const VERSION = 'v1';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/** Нормализация ENCRYPTION_KEY → 32 байта. */
export function normalizeEncryptionKey(key: string): Buffer {
  if (key.length === 0) throw new CryptoError('ENCRYPTION_KEY пуст');

  // путь 1: base64 из 32 случайных байтов (рекомендованный формат)
  const asBase64 = Buffer.from(key, 'base64');
  if (asBase64.length === 32 && /^[A-Za-z0-9+/=]+$/.test(key)) return asBase64;

  // путь 2: произвольная строка ≥32 символов → детерминированный ключ
  if (key.length >= 32) return createHash('sha256').update(key, 'utf8').digest();

  throw new CryptoError(
    'ENCRYPTION_KEY: ожидается base64 32 байтов (openssl rand -base64 32) или строка ≥32 символов',
  );
}

function toB64u(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64u(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Зашифровать: уникальный IV (12 байт) на каждый вызов. */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const key = normalizeEncryptionKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, toB64u(iv), toB64u(tag), toB64u(ciphertext)].join('.');
}

/** Расшифровать. Бросает CryptoError при неверном ключе/повреждённых данных. */
export function decryptSecret(encrypted: string, encryptionKey: string): string {
  const key = normalizeEncryptionKey(encryptionKey);
  const parts = encrypted.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CryptoError('Неверный формат шифротекста (ожидается v1.iv.tag.ct)');
  }
  // noUncheckedIndexedAccess: дефолты безопасны — длина проверена выше
  const [, ivPart = '', tagPart = '', ctPart = ''] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, fromB64u(ivPart));
    decipher.setAuthTag(fromB64u(tagPart));
    return Buffer.concat([decipher.update(fromB64u(ctPart)), decipher.final()]).toString('utf8');
  } catch {
    throw new CryptoError('Расшифровка не удалась: неверный ключ или повреждённые данные');
  }
}
