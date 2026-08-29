import type { TelegramTransport } from './telegramTypes.js';

/**
 * Минимальный HTTP-транспорт Telegram Bot API для ОТПРАВКИ из worker
 * (без grammY — роутинг update'ов здесь не нужен, только sendMessage/
 * sendDocument). apiRoot переопределяется на мок в тестах/песочнице.
 * Дублирование ботовского транспорта — TD-011 (консолидация в packages/*).
 */

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

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export function createHttpTransport(token: string, apiRoot = 'https://api.telegram.org', fetchImpl: FetchLike = fetch): TelegramTransport {
  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${apiRoot}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = { ok: res.ok };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // сеть/HTML-ответ
      throw new Error(`telegram transport: non-JSON response (${res.status})`);
    }
    if (!parsed.ok) {
      const match = /retry after (\d+)/.exec(parsed.description ?? '');
      throw new TelegramApiError(
        res.status,
        parsed.description ?? 'unknown error',
        match?.[1] ? Number(match[1]) : parsed.parameters?.retry_after,
      );
    }
    return parsed.result as T;
  }

  return {
    async sendMessage(chatId, text, buttons) {
      const msg = await call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text,
        ...(buttons && buttons.length > 0
          ? { reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.callbackData }]) } }
          : {}),
      });
      return String(msg.message_id);
    },
    async sendDocument(chatId, url, _filename, caption) {
      const msg = await call<{ message_id: number }>('sendDocument', {
        chat_id: chatId,
        document: url,
        ...(caption !== undefined ? { caption } : {}),
      });
      return String(msg.message_id);
    },
    async answerCallbackQuery(): Promise<void> {
      // worker не получает callback_query
      throw new Error('answerCallbackQuery не поддерживается транспортом worker');
    },
    async setWebhook(): Promise<void> {
      throw new Error('setWebhook не поддерживается транспортом worker');
    },
  };
}
