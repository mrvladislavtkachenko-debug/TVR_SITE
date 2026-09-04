from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Database:
    """Persistent state for one search and any authorised Telegram subscribers."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA busy_timeout=5000")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS subscribers (
                chat_id INTEGER PRIMARY KEY,
                active INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS state (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def subscribe(self, chat_id: int) -> None:
        self.connection.execute(
            """
            INSERT INTO subscribers(chat_id, active, updated_at) VALUES (?, 1, ?)
            ON CONFLICT(chat_id) DO UPDATE SET active=1, updated_at=excluded.updated_at
            """,
            (chat_id, now()),
        )
        self.connection.commit()

    def unsubscribe(self, chat_id: int) -> None:
        self.connection.execute(
            "UPDATE subscribers SET active=0, updated_at=? WHERE chat_id=?", (now(), chat_id)
        )
        self.connection.commit()

    def subscribers(self) -> list[int]:
        rows = self.connection.execute(
            "SELECT chat_id FROM subscribers WHERE active=1 ORDER BY chat_id"
        ).fetchall()
        return [int(row["chat_id"]) for row in rows]

    def get(self, key: str) -> str | None:
        row = self.connection.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return None if row is None else row["value"]

    def put(self, key: str, value: str | None) -> None:
        self.connection.execute(
            """
            INSERT INTO state(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (key, value),
        )
        self.connection.commit()
