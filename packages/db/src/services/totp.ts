import { authenticator } from 'otplib';
import { decryptSecret } from '../crypto.js';

/**
 * Проверка TOTP-кода админа: секрет хранится зашифрованным (AES-256-GCM,
 * ENCRYPTION_KEY — Э6); окно ±1 шаг (30s) на рассинхрон часов.
 */
export function verifyTotp(
  token: string,
  totpSecretEncrypted: string,
  encryptionKey: string,
): boolean {
  try {
    const secret = decryptSecret(totpSecretEncrypted, encryptionKey);
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}

/** Сгенерировать код по секрету (для тестов). */
export function totpCode(totpSecretEncrypted: string, encryptionKey: string): string {
  const secret = decryptSecret(totpSecretEncrypted, encryptionKey);
  return authenticator.generate(secret);
}
