import { describe, expect, it } from 'vitest';
import { CryptoError, decryptSecret, encryptSecret, normalizeEncryptionKey } from '../src/crypto.js';

// openssl rand -base64 32 → 32 байта base64
const KEY_B64 = Buffer.from('a'.repeat(32)).toString('base64');
const KEY_RAW = 'raw-key-string-with-at-least-32-chars!!';

describe('normalizeEncryptionKey', () => {
  it('base64 из 32 байтов → ключ 32 байта', () => {
    expect(normalizeEncryptionKey(KEY_B64).length).toBe(32);
  });

  it('строка ≥32 символов → SHA-256 (32 байта)', () => {
    expect(normalizeEncryptionKey(KEY_RAW).length).toBe(32);
  });

  it('короткий ключ → CryptoError', () => {
    expect(() => normalizeEncryptionKey('short')).toThrow(CryptoError);
    expect(() => normalizeEncryptionKey('')).toThrow(CryptoError);
  });
});

describe('AES-256-GCM roundtrip (Э6)', () => {
  it('decrypt(encrypt(x)) === x', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // base32 TOTP-подобный
    const enc = encryptSecret(secret, KEY_B64);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(enc, KEY_B64)).toBe(secret);
  });

  it('каждое шифрование — уникальный IV (разные шифротексты)', () => {
    const a = encryptSecret('same-plaintext', KEY_B64);
    const b = encryptSecret('same-plaintext', KEY_B64);
    expect(a).not.toBe(b);
  });

  it('работает с raw-ключом ≥32 символов', () => {
    const enc = encryptSecret('secret-data', KEY_RAW);
    expect(decryptSecret(enc, KEY_RAW)).toBe('secret-data');
  });

  it('неверный ключ → CryptoError (GCM tag check)', () => {
    const enc = encryptSecret('secret-data', KEY_B64);
    const otherKey = Buffer.from('b'.repeat(32)).toString('base64');
    expect(() => decryptSecret(enc, otherKey)).toThrow(CryptoError);
  });

  it('повреждённый шифротекст → CryptoError', () => {
    const enc = encryptSecret('secret-data', KEY_B64);
    const tampered = `${enc.slice(0, -4)}AAAA`;
    expect(() => decryptSecret(tampered, KEY_B64)).toThrow(CryptoError);
    expect(() => decryptSecret('garbage', KEY_B64)).toThrow(CryptoError);
  });
});
