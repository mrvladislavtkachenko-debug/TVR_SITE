/**
 * Seed-CLI админа (Э6/AN-11): argon2id (OWASP) + TOTP-секрет,
 * зашифрованный AES-256-GCM ключом ENCRYPTION_KEY.
 * Запуск:
 *   pnpm --filter @tas/db seed:admin -- --email owner@example.com --password 'S3cure!pass' [--reset]
 * Секрет TOTP печатается один раз в otpauth:// URI — сохраните в authenticator.
 * Требует только DATABASE_URL + ENCRYPTION_KEY (adminSeedEnvSchema).
 */
import { authenticator } from 'otplib';
import { adminSeedEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { createPrisma } from '../src/client.js';
import { decryptSecret, encryptSecret } from '../src/crypto.js';
import { hashPassword } from '../src/argon2.js';

interface Args {
  email?: string;
  password?: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') args.email = argv[++i];
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--reset') args.reset = true;
    else {
      console.error(`Неизвестный аргумент: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  loadRootEnv();
  const env = parseEnv(adminSeedEnvSchema);
  const args = parseArgs(process.argv.slice(2));

  if (!args.email || !args.password) {
    console.error('Использование: seed:admin -- --email <email> --password <password> [--reset]');
    process.exit(2);
  }
  const email = args.email.toLowerCase().trim(); // AN-12: нормализация
  const password = args.password;
  if (!EMAIL_RE.test(email)) {
    console.error('Некорректный email');
    process.exit(2);
  }
  if (password.length < 10) {
    console.error('Пароль: минимум 10 символов');
    process.exit(2);
  }

  const prisma = createPrisma(env.DATABASE_URL);
  const existing = await prisma.admin_users.findUnique({ where: { email } });
  if (existing && !args.reset) {
    console.error(`Админ ${email} уже существует. Используйте --reset для перегенерации пароля/TOTP.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const totpSecret = authenticator.generateSecret(20); // base32, 160 бит
  const encrypted = encryptSecret(totpSecret, env.ENCRYPTION_KEY);

  await prisma.admin_users.upsert({
    where: { email },
    update: { password_hash: passwordHash, totp_secret_encrypted: encrypted, is_active: true },
    create: { email, password_hash: passwordHash, totp_secret_encrypted: encrypted, role: 'owner' },
  });
  await prisma.$disconnect();

  // самопроверка: расшифровка должна вернуть исходный секрет
  const roundtrip = decryptSecret(encrypted, env.ENCRYPTION_KEY);
  if (roundtrip !== totpSecret) {
    console.error('SELF-CHECK FAILED: расшифровка TOTP-секрета не совпала');
    process.exit(1);
  }

  console.log(`Admin ${email} ${existing ? 'reset' : 'created'} (argon2id, TOTP AES-256-GCM).`);
  console.log('\nOTPAuth URI (сохраните в authenticator, показывается один раз):');
  console.log(authenticator.keyuri(email, 'TAS', totpSecret));
}

void main().catch((err: unknown) => {
  console.error('seed:admin failed:', err);
  process.exit(1);
});
