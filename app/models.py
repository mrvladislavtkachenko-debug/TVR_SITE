from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True, slots=True)
class LatestListing:
    listing_id: str
    title: str
    url: str
    price: str | None = None
    location: str | None = None
    published_at: str | None = None
    description: str | None = None
    seller: str | None = None
    seller_url: str | None = None
    image_url: str | None = None

    def merged(self, details: LatestListing) -> LatestListing:
        """Keep reliable card values when a detail page omits one of them."""
        return replace(
            self,
            title=details.title or self.title,
            price=details.price or self.price,
            location=details.location or self.location,
            published_at=details.published_at or self.published_at,
            description=details.description or self.description,
            seller=details.seller or self.seller,
            seller_url=details.seller_url or self.seller_url,
            image_url=details.image_url or self.image_url,
        )


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
