from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .config import Settings
from .database import Database, now
from .models import CheckResult, LatestListing
from .source import AccessBlocked, AvitoSource, RateLimited, SourceError

Notify = Callable[[LatestListing], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class MonitorStatus:
    last_attempt_at: str | None
    last_success_at: str | None
    last_error: str | None
    last_listing_id: str | None
    paused_until: str | None


class LatestMonitor:
    """Fetches only the first result and remembers its ID."""

    def __init__(self, settings: Settings, database: Database) -> None:
        self.settings = settings
        self.database = database
        self.source = AvitoSource(
            settings.search_url, settings.user_agent, settings.timeout_seconds
        )
        self._lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._wake = asyncio.Event()
        self._next_allowed = 0.0
        self._paused_until: datetime | None = None
        self._failures = 0

    async def close(self) -> None:
        self._stop.set()
        self._wake.set()
        await self.source.close()

    def wake(self) -> None:
        self._wake.set()

    def remaining(self) -> int:
        return max(0, int(self._next_allowed - time.monotonic()))

    def status(self) -> MonitorStatus:
        paused = self._paused_until.isoformat(timespec="seconds") if self._paused_until else None
        return MonitorStatus(
            self.database.get("last_attempt_at"),
            self.database.get("last_success_at"),
            self.database.get("last_error"),
            self.database.get("last_listing_id"),
            paused,
        )

    async def check(self, *, automatic: bool = False) -> CheckResult:
        """Read the first result once. Both manual and automatic checks share cooldown."""
        async with self._lock:
            if automatic and not self.database.subscribers():
                return CheckResult()
            remaining = self.remaining()
            if remaining:
                return CheckResult(skipped=True, retry_after_seconds=remaining)

            self.database.put("last_attempt_at", now())
            try:
                result = await self.source.latest(
                    self.database.get("etag"),
                    self.database.get("last_modified"),
                    conditional=automatic,
                )
                if result.etag:
                    self.database.put("etag", result.etag)
                if result.last_modified:
                    self.database.put("last_modified", result.last_modified)

                self._failures = 0
                self._paused_until = None
                self._next_allowed = time.monotonic() + self.settings.interval_seconds
                self.database.put("last_success_at", now())
                self.database.put("last_error", None)
                if result.not_modified:
                    return CheckResult(not_modified=True)
                if result.listing is None:
                    return CheckResult()

                previous_id = self.database.get("last_listing_id")
                is_baseline = previous_id is None
                is_new = previous_id is not None and previous_id != result.listing.listing_id
                listing = result.listing
                # The search page is enough for the baseline. Fetch the detail page
                # only for a manual request or a genuinely new top result.
                if not automatic or is_new:
                    listing = await self.source.enrich(listing)
                self.database.put("last_listing_id", listing.listing_id)
                return CheckResult(
                    listing=listing,
                    sent_as_new=is_new,
                    baseline_created=is_baseline,
                )
            except RateLimited as exc:
                return self._error(str(exc), exc.retry_after)
            except AccessBlocked as exc:
                # A block is a signal to stop, not an invitation to rotate IPs or solve CAPTCHA.
                return self._error(str(exc), max(3600, self.settings.interval_seconds))
            except SourceError as exc:
                return self._error(str(exc), None)
            except Exception as exc:  # noqa: BLE001 - one parser error must not kill the bot.
                return self._error(f"Внутренняя ошибка: {exc}", None)

    def _error(self, message: str, retry_after: int | None) -> CheckResult:
        self._failures += 1
        exponential = self.settings.interval_seconds * 2 ** min(self._failures - 1, 6)
        delay = retry_after if retry_after is not None else exponential
        delay = max(self.settings.interval_seconds, min(delay, self.settings.max_backoff_seconds))
        self._next_allowed = time.monotonic() + delay
        self._paused_until = datetime.now(UTC) + timedelta(seconds=delay)
        self.database.put("last_error", message)
        return CheckResult(error=message, retry_after_seconds=delay)

    async def run(self, notify: Notify) -> None:
        try:
            while not self._stop.is_set():
                self._wake.clear()
                report = await self.check(automatic=True)
                if report.sent_as_new and report.listing is not None:
                    await notify(report.listing)
                wait_for = self.remaining() or min(self.settings.interval_seconds, 30)
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=wait_for)
                except TimeoutError:
                    pass
        finally:
            await self.source.close()
