import type { Update } from 'grammy/types';
import type { Bot } from 'grammy';
import type { SqlExecutor } from '@tas/db/services';
import type { BotTemplate, TemplateStore } from '../../src/templates.js';
import type { TelegramTransport } from '../../src/telegram.js';
import { createBot } from '../../src/telegram.js';
import type { TelegramApiError } from '../../src/telegram.js';
import type { BotLogger } from '../../src/pipeline.js';
import { registerBotHandlers } from '../../src/handlers.js';
import { FakeBotDb, seedBotTemplates } from './fakeDb.js';

/** Строители Telegram update (минимальная форма для маршрутизации grammY). */

let messageSeq = 100;

export function startUpdate(updateId: number, telegramId: number, payload?: string, username = 'anna'): Update {
  messageSeq += 1;
  const text = payload === undefined ? '/start' : `/start ${payload}`;
  const cmdLen = 6;
  return {
    update_id: updateId,
    message: {
      message_id: messageSeq,
      from: { id: telegramId, is_bot: false, first_name: 'Anna', username, language_code: 'en' },
      chat: { id: telegramId, type: 'private', first_name: 'Anna' },
      date: Math.floor(Date.now() / 1000),
      text,
      entities: [{ offset: 0, length: cmdLen, type: 'bot_command' }],
    },
  } as unknown as Update;
}

export function textUpdate(updateId: number, telegramId: number, text: string): Update {
  messageSeq += 1;
  // grammY матчит bot.command по entities; для команд добавляем bot_command-entity
  const cmdMatch = /^\/([A-Za-z_]+)(@\S+)?/.exec(text);
  return {
    update_id: updateId,
    message: {
      message_id: messageSeq,
      from: { id: telegramId, is_bot: false, first_name: 'Anna', username: 'anna' },
      chat: { id: telegramId, type: 'private', first_name: 'Anna' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(cmdMatch
        ? { entities: [{ offset: 0, length: cmdMatch[0].length, type: 'bot_command' }] }
        : {}),
    },
  } as unknown as Update;
}

export function callbackUpdate(updateId: number, telegramId: number, data: string): Update {
  messageSeq += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq${updateId}`,
      from: { id: telegramId, is_bot: false, first_name: 'Anna', username: 'anna' },
      message: {
        message_id: messageSeq,
        chat: { id: telegramId, type: 'private', first_name: 'Anna' },
        date: Math.floor(Date.now() / 1000),
        text: 'inline keyboard',
      },
      data,
    },
  } as unknown as Update;
}

/** Map-хранилище шаблонов поверх FakeBotDb.templates. */
export function mapTemplateStore(templates: Map<string, BotTemplate>): TemplateStore {
  return {
    async get(code) {
      return templates.get(code) ?? null;
    },
  };
}

/** Захватывающий in-memory транспорт (эффемерные ack + ошибки по сценарию). */
export class FakeTransport implements TelegramTransport {
  sent: { method: string; chatId: string; text?: string; buttons?: unknown; url?: string; caption?: string }[] = [];
  answers: { id: string; text?: string }[] = [];
  /** Очередь запрограммированных ошибок ({throw} — исключение). */
  errors: (TelegramApiError | Error)[] = [];

  private popError(): unknown {
    return this.errors.length > 0 ? this.errors.shift() : undefined;
  }

  async sendMessage(chatId: string, text: string, buttons?: { text: string; callbackData: string }[]): Promise<string> {
    const err = this.popError();
    if (err) throw err;
    this.sent.push({ method: 'sendMessage', chatId, text, buttons });
    return String(9000 + this.sent.length);
  }

  async sendDocument(chatId: string, url: string, _filename: string, caption?: string): Promise<string> {
    const err = this.popError();
    if (err) throw err;
    this.sent.push({ method: 'sendDocument', chatId, url, caption });
    return String(9000 + this.sent.length);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answers.push({ id: callbackQueryId, text });
  }

  async setWebhook(): Promise<void> {
    // не используется в unit-тестах
  }
}

/** Логгер-шпион: собирает строки для privacy-проверок (§16.3). */
export class MemoryLogger implements BotLogger {
  lines: { level: string; msg: string; obj: object }[] = [];
  info(obj: object, msg: string): void {
    this.lines.push({ level: 'info', msg, obj });
  }
  warn(obj: object, msg: string): void {
    this.lines.push({ level: 'warn', msg, obj });
  }
  error(obj: object, msg: string): void {
    this.lines.push({ level: 'error', msg, obj });
  }
  dump(): string {
    return this.lines.map((l) => JSON.stringify({ msg: l.msg, ...l.obj })).join('\n');
  }
}

export interface TestHarness {
  db: FakeBotDb;
  bot: Bot;
  transport: FakeTransport;
  log: MemoryLogger;
  executor: SqlExecutor;
}

/** Полный стенд: бот + фейк-БД с шаблонами + фейк-транспорт + шпион-логгер. */
export function makeHarness(): TestHarness {
  const db = new FakeBotDb();
  seedBotTemplates(db);
  const transport = new FakeTransport();
  const log = new MemoryLogger();
  const bot = createBot('123456:TESTTOKEN');
  // без getMe: preset botInfo исключает сетевой вызов grammY
  bot.botInfo = { id: 1, is_bot: true, first_name: 'TAS', username: 'TASDevBot' } as typeof bot.botInfo;
  registerBotHandlers(bot, {
    executor: db.executor,
    templates: mapTemplateStore(db.templates),
    transport,
    leadMagnet: { url: 'https://files.example.com/lm.pdf', filename: 'lm.pdf' },
    tokenFormat: { prefix: 't1', length: 10 },
    log,
  });
  return { db, bot, transport, log, executor: db.executor };
}

export async function runUpdate(bot: Bot, update: Update): Promise<void> {
  await bot.handleUpdate(update);
}
