/**
 * Транспортно-независимый интерфейс отправки в Telegram
 * (структурно идентичен apps/bot/src/telegram.ts — консолидация в TD-011).
 */

export interface TgButton {
  text: string;
  callbackData: string;
}

export interface TelegramTransport {
  sendMessage(chatId: string, text: string, buttons?: TgButton[]): Promise<string>;
  sendDocument(chatId: string, url: string, filename: string, caption?: string): Promise<string>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setWebhook(url: string, secret: string, allowedUpdates: string[]): Promise<void>;
}
