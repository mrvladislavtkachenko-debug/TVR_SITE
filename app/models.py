from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class LatestListing:
    listing_id: str
    title: str
    url: str
    price: str | None = None
    location: str | None = None
    published_at: str | None = None
    image_url: str | None = None


@dataclass(frozen=True, slots=True)
class LatestResult:
    listing: LatestListing | None
    etag: str | None = None
    last_modified: str | None = None
    not_modified: bool = False


@dataclass(frozen=True, slots=True)
class CheckResult:
    listing: LatestListing | None = None
    sent_as_new: bool = False
    baseline_created: bool = False
    skipped: bool = False
    error: str | None = None
    retry_after_seconds: int | None = None
    not_modified: bool = False
