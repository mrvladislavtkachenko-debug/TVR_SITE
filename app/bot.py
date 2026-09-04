from __future__ import annotations

import asyncio
import html
import logging
import signal

from telegram import BotCommand, Update
from telegram.constants import ParseMode
from telegram.error import Forbidden, TelegramError
from telegram.ext import Application, CommandHandler, ContextTypes

from .config import Settings
from .database import Database
from .models import LatestListing
from .monitor import LatestMonitor

logger = logging.getLogger(__name__)


def _escape(value: str | None) -> str:
    return html.escape(value or "", quote=True)


def format_listing(listing: LatestListing) -> str:
    lines = [
        "<b>Последнее объявление на Avito</b>",
        f'<a href="{_escape(listing.url)}">{_escape(listing.title)}</a>',
    ]
    if listing.price:
        lines.append(f"Цена: {_escape(listing.price)}")
    if listing.location:
        lines.append(f"Место: {_escape(listing.location)}")
    if listing.published_at:
        lines.append(f"Опубликовано: {_escape(listing.published_at)}")
    lines.append(f'<a href="{_escape(listing.url)}">Открыть объявление</a>')
    return "\n".join(lines)


class TelegramBot:
    def __init__(self, settings: Settings, database: Database, monitor: LatestMonitor) -> None:
        self.settings = settings
        self.database = database
        self.monitor = monitor
        self.application = (
            Application.builder()
            .token(settings.bot_token)
            .post_init(self._post_init)
            .build()
        )
        self.application.add_handler(CommandHandler("start", self.start))
        self.application.add_handler(CommandHandler("latest", self.latest))
        self.application.add_handler(CommandHandler("check", self.latest))
        self.application.add_handler(CommandHandler("watch", self.watch))
        self.application.add_handler(CommandHandler("stop", self.stop))
        self.application.add_handler(CommandHandler("status", self.status))
        self.application.add_error_handler(self.on_error)

    async def _post_init(self, application: Application) -> None:
        await application.bot.set_my_commands(
            [
                BotCommand("latest", "прислать последнее объявление"),
                BotCommand("watch", "включить автоуведомления"),
                BotCommand("stop", "выключить автоуведомления"),
                BotCommand("status", "показать статус"),
            ]
        )

    @staticmethod
    def _chat_id(update: Update) -> int | None:
        return update.effective_chat.id if update.effective_chat else None

    async def _access(self, update: Update) -> int | None:
        chat_id = self._chat_id(update)
        if chat_id is None:
            return None
        if not self.settings.chat_allowed(chat_id):
            if update.effective_message:
                await update.effective_message.reply_text("У этого чата нет доступа к боту.")
            return None
        return chat_id

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat_id = await self._access(update)
        if chat_id is None:
            return
        self.database.subscribe(chat_id)
        self.monitor.wake()
        await update.effective_message.reply_text(
            "Готово. Автоуведомления включены.\n\n"
            "Чтобы получить объявление прямо сейчас, отправьте /latest."
        )

    async def watch(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self.start(update, context)

    async def stop(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat_id = await self._access(update)
        if chat_id is None:
            return
        self.database.unsubscribe(chat_id)
        self.monitor.wake()
        await update.effective_message.reply_text("Автоуведомления выключены.")

    async def latest(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat_id = await self._access(update)
        if chat_id is None:
            return
        result = await self.monitor.check()
        if result.skipped:
            await update.effective_message.reply_text(
                f"Запрос уже выполнялся. Повторить можно примерно через "
                f"{result.retry_after_seconds} сек."
            )
            return
        if result.error:
            await update.effective_message.reply_text(
                f"Не удалось получить объявление: {result.error}\n"
                f"Следующая попытка — примерно через {result.retry_after_seconds} сек."
            )
            return
        if result.listing is None:
            await update.effective_message.reply_text(
                "На странице поиска сейчас не найдено объявлений."
            )
            return
        await update.effective_message.reply_text(
            format_listing(result.listing), parse_mode=ParseMode.HTML, disable_web_page_preview=False
        )

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        chat_id = await self._access(update)
        if chat_id is None:
            return
        status = self.monitor.status()
        lines = [
            "<b>Статус</b>",
            f"Интервал проверки: {self.settings.interval_seconds} сек.",
            f"Подписчиков: {len(self.database.subscribers())}",
            f"Последняя попытка: {_escape(status.last_attempt_at) or 'ещё не было'}",
            f"Последний успешный ответ: {_escape(status.last_success_at) or 'ещё не было'}",
            f"Последний ID: {_escape(status.last_listing_id) or 'ещё не было'}",
        ]
        remaining = self.monitor.remaining()
        if remaining:
            lines.append(f"До следующей проверки: {remaining} сек.")
        if status.paused_until:
            lines.append(f"Пауза до: {_escape(status.paused_until)}")
        if status.last_error:
            lines.append(f"Ошибка: {_escape(status.last_error)}")
        await update.effective_message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML)

    async def _notify(self, listing: LatestListing) -> None:
        text = format_listing(listing)
        for chat_id in self.database.subscribers():
            try:
                await self.application.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=ParseMode.HTML,
                    disable_web_page_preview=False,
                )
            except Forbidden:
                logger.info("Чат %s заблокировал бота; отключаем подписку", chat_id)
                self.database.unsubscribe(chat_id)
            except TelegramError as exc:
                logger.warning("Не удалось отправить уведомление в чат %s: %s", chat_id, exc)

    async def _watch_loop(self) -> None:
        await self.monitor.run(self._notify)

    async def on_error(self, update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        logger.error("Ошибка обработки Telegram update: %s", context.error, exc_info=context.error)

    async def run(self) -> None:
        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signame in ("SIGINT", "SIGTERM"):
            signum = getattr(signal, signame, None)
            if signum is not None:
                try:
                    loop.add_signal_handler(signum, stop_event.set)
                except (NotImplementedError, RuntimeError):
                    pass

        await self.application.initialize()
        await self.application.start()
        if self.application.updater is None:
            raise RuntimeError("Telegram updater is not configured")
        await self.application.updater.start_polling(drop_pending_updates=True)
        watcher = asyncio.create_task(self._watch_loop(), name="latest-listing-watch")
        logger.info("Бот запущен; search URL: %s", self.settings.search_url)
        try:
            await stop_event.wait()
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
            await self.application.updater.stop()
            await self.application.stop()
            await self.application.shutdown()
            await self.monitor.close()
            self.database.close()
            logger.info("Бот остановлен")


async def run_bot(settings: Settings) -> None:
    database = Database(settings.database_path)
    monitor = LatestMonitor(settings, database)
    await TelegramBot(settings, database, monitor).run()
