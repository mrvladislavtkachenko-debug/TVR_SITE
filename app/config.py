from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv


class ConfigurationError(ValueError):
    """A required setting is missing or unsafe."""


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigurationError(f"Не задана обязательная переменная {name}")
    return value


def _int_setting(name: str, default: int, minimum: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} должна быть целым числом") from exc
    if value < minimum:
        raise ConfigurationError(f"{name} должна быть не меньше {minimum}")
    return value


def _chat_ids(name: str) -> frozenset[int]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return frozenset()
    try:
        return frozenset(int(item.strip()) for item in raw.split(","))
    except ValueError as exc:
        raise ConfigurationError(f"{name} должна содержать Telegram chat ID через запятую") from exc


def _search_url(value: str) -> str:
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https":
        raise ConfigurationError("AVITO_SEARCH_URL должен использовать HTTPS")
    if hostname != "avito.ru" and not hostname.endswith(".avito.ru"):
        raise ConfigurationError("AVITO_SEARCH_URL должен вести на avito.ru")
    if not parsed.path or parsed.path == "/":
        raise ConfigurationError("AVITO_SEARCH_URL должен быть ссылкой на страницу поиска")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    bot_token: str
    search_url: str
    database_path: Path
    interval_seconds: int
    timeout_seconds: int
    max_backoff_seconds: int
    user_agent: str
    allowed_chat_ids: frozenset[int]

    @classmethod
    def from_env(cls) -> Settings:
        load_dotenv()
        interval = _int_setting("POLL_INTERVAL_SECONDS", 300, 60)
        return cls(
            bot_token=_required("TELEGRAM_BOT_TOKEN"),
            search_url=_search_url(_required("AVITO_SEARCH_URL")),
            database_path=Path(os.getenv("DATABASE_PATH", "data/bot.sqlite3")).expanduser(),
            interval_seconds=interval,
            timeout_seconds=_int_setting("REQUEST_TIMEOUT_SECONDS", 20, 5),
            max_backoff_seconds=_int_setting("MAX_BACKOFF_SECONDS", 21600, interval),
            user_agent=os.getenv(
                "AVITO_USER_AGENT", "AvitoLatestBot/1.0 (+mailto:you@example.com)"
            ).strip(),
            allowed_chat_ids=_chat_ids("TELEGRAM_ALLOWED_CHAT_IDS"),
        )

    def __post_init__(self) -> None:
        if not self.user_agent:
            raise ConfigurationError("AVITO_USER_AGENT не должен быть пустым")
        self.database_path.parent.mkdir(parents=True, exist_ok=True)

    def chat_allowed(self, chat_id: int) -> bool:
        # Empty allow-list is convenient during local setup. For a deployed bot set
        # TELEGRAM_ALLOWED_CHAT_IDS so other users cannot subscribe to it.
        return not self.allowed_chat_ids or chat_id in self.allowed_chat_ids
