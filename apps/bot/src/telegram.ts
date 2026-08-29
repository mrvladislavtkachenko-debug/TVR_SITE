import { Bot, GrammyError } from 'grammy';
import type { Update } from 'grammy/types';

/**
 * Транспорт в Telegram Bot API на grammY (§20, §39.7).
 * apiRoot переопределяется на мок-сервер в тестах/песочнице — мок Telegram
 * честно прогоняет HTTP-сериализацию grammY.
 */

export interface TgButton {
  text: string;
  callbackData: string;
}

export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram API ${code}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramTransport {
  sendMessage(chatId: string, text: string, buttons?: TgButton[]): Promise<string>;
  sendDocument(
    chatId: string,
    url: string,
    filename: string,
    caption?: string,
  ): Promise<string>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setWebhook(url: string, secret: string, allowedUpdates: string[]): Promise<void>;
}

/** canUseWebhookReply: () => false — мы ACK'аем webhook ДО обработки (§28.12). */
export function createBot(token: string, apiRoot?: string): Bot {
  return new Bot(token, {
    client: { apiRoot: apiRoot ?? undefined, canUseWebhookReply: () => false },
  });
}

function toApiError(err: unknown): unknown {
  if (err instanceof GrammyError) {
    const match = /retry after (\d+)/.exec(err.description);
    return new TelegramApiError(
      err.error_code,
      err.description,
      match ? Number(match[1]) : undefined,
    );
  }
  return err;
}

function inlineKeyboard(buttons: TgButton[] | undefined) {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    reply_markup: {
      inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.callbackData }]),
    },
  };
}

export function createTransport(bot: Bot): TelegramTransport {
  return {
    async sendMessage(chatId, text, buttons) {
      try {
        const msg = await bot.api.sendMessage(Number(chatId), text, inlineKeyboard(buttons));
        return String(msg.message_id);
      } catch (err) {
        throw toApiError(err);
      }
    },
    async sendDocument(chatId, url, _filename, caption) {
      try {
        // URL-документ: Telegram сам скачивает файл по HTTPS (sendDocument(url))
        const msg = await bot.api.sendDocument(Number(chatId), url, caption ? { caption } : {});
        return String(msg.message_id);
      } catch (err) {
        throw toApiError(err);
      }
    },
    async answerCallbackQuery(callbackQueryId, text) {
      try {
        await bot.api.answerCallbackQuery(callbackQueryId, text ? { text } : {});
      } catch (err) {
        throw toApiError(err);
      }
    },
    async setWebhook(url, secret, allowedUpdates) {
      try {
        await bot.api.setWebhook(url, {
          secret_token: secret,
          allowed_updates: allowedUpdates as never,
          drop_pending_updates: false,
        });
      } catch (err) {
        throw toApiError(err);
      }
    },
  };
}

export type { Update };
