/**
 * CLI: регистрация webhook в Telegram (runbook «webhook-reset», §39.13).
 *   pnpm --filter @tas/bot set-webhook
 * Требует TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL.
 */
import { botEnvSchema, loadRootEnv, parseEnv } from '@tas/shared';
import { createBot, createTransport } from './telegram.js';

loadRootEnv();
const env = parseEnv(botEnvSchema);
const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhook/telegram`;

const bot = createBot(env.TELEGRAM_BOT_TOKEN);
const transport = createTransport(bot);

transport
  .setWebhook(url, env.TELEGRAM_WEBHOOK_SECRET, ['message', 'callback_query'])
  .then(() => {
    console.log(`Webhook установлен: ${url} (allowed_updates: message, callback_query)`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('setWebhook failed:', err);
    process.exit(1);
  });
