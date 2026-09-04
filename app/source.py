from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup, Tag

from .models import LatestListing, LatestResult


class SourceError(RuntimeError):
    """The configured source could not provide a latest listing."""


class AccessBlocked(SourceError):
    """The source returned an access-control or CAPTCHA page."""


class RateLimited(SourceError):
    def __init__(self, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class TemporarySourceError(SourceError):
    pass


def _text(value: str | None, limit: int = 500) -> str | None:
    if not value:
        return None
    value = " ".join(value.split())
    return value[:limit] or None


def _avito_url(href: str, base_url: str) -> str | None:
    absolute = urljoin(base_url, href)
    parts = urlsplit(absolute)
    hostname = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme != "https" or (hostname != "avito.ru" and not hostname.endswith(".avito.ru")):
        return None
    return urlunsplit(("https", hostname, parts.path.rstrip("/"), "", ""))


def _id_for(url: str, container: Tag | None = None) -> str:
    if container is not None:
        for attribute in ("data-item-id", "data-id"):
            value = container.get(attribute)
            if value and re.fullmatch(r"[A-Za-z0-9_-]{3,100}", str(value)):
                return str(value)
    match = re.search(r"(?:/item/|_|/)(\d{5,})(?:/)?$", urlsplit(url).path)
    if match:
        return match.group(1)
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]


def _container(anchor: Tag) -> Tag:
    for attributes in ({"data-marker": "item"}, {"data-item-id": True}):
        parent = anchor.find_parent(attrs=attributes)
        if parent is not None:
            return parent
    return anchor.parent if isinstance(anchor.parent, Tag) else anchor


def _marked_text(container: Tag, *markers: str) -> str | None:
    for marker in markers:
        element = container.find(attrs={"data-marker": marker})
        if element is not None:
            return _text(element.get_text(" ", strip=True))
    return None


def _image(container: Tag) -> str | None:
    image = container.find("img")
    if image is None:
        return None
    for attribute in ("src", "data-src", "data-original"):
        value = image.get(attribute)
        if value:
            return str(value)
    srcset = image.get("srcset")
    return str(srcset).split(",", 1)[0].strip().split(" ", 1)[0] if srcset else None


def _first_card(soup: BeautifulSoup, base_url: str) -> LatestListing | None:
    anchor = soup.select_one('a[data-marker="item-title"]')
    if anchor is None:
        # This fallback handles a small number of older layouts. It is deliberately
        # limited to anchors that look like an item link, not arbitrary page links.
        for candidate in soup.select("a[href]"):
            href = str(candidate.get("href"))
            if ("/item/" in href or re.search(r"_\d{5,}(?:\?|$)", href)) and candidate.get_text(
                " ", strip=True
            ):
                anchor = candidate
                break
    if anchor is None:
        return None

    href = anchor.get("href")
    title = _text(anchor.get_text(" ", strip=True))
    if not isinstance(href, str) or not title:
        return None
    url = _avito_url(href, base_url)
    if url is None:
        return None
    card = _container(anchor)
    return LatestListing(
        listing_id=_id_for(url, card),
        title=title,
        url=url,
        price=_marked_text(card, "item-price", "item-price-text"),
        location=_marked_text(card, "item-address", "item-location"),
        published_at=_marked_text(card, "item-date", "item-publish-date"),
        image_url=_image(card),
    )


def _json_ld_latest(soup: BeautifulSoup, base_url: str) -> LatestListing | None:
    """Fallback for pages exposing the first result in JSON-LD."""
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(script.string or script.get_text())
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        objects = data if isinstance(data, list) else [data]
        for obj in objects:
            if not isinstance(obj, dict):
                continue
            elements = obj.get("itemListElement")
            candidates = elements if isinstance(elements, list) else [obj]
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                item = candidate.get("item")
                if not isinstance(item, dict):
                    item = candidate
                if not isinstance(item.get("url"), str) or not isinstance(item.get("name"), str):
                    continue
                if not elements and item.get("@type") not in {"Product", "Offer"}:
                    continue
                url = _avito_url(item["url"], base_url)
                if url is None:
                    continue
                offers = item.get("offers") if isinstance(item.get("offers"), dict) else {}
                price = offers.get("price")
                if price is not None:
                    price = f"{price} {offers.get('priceCurrency', 'RUB')}"
                return LatestListing(
                    listing_id=_id_for(url),
                    title=_text(item["name"]) or "Без названия",
                    url=url,
                    price=_text(str(price)) if price is not None else None,
                    image_url=item.get("image") if isinstance(item.get("image"), str) else None,
                )
    return None


def parse_latest(html: str, base_url: str) -> LatestListing | None:
    soup = BeautifulSoup(html, "html.parser")
    return _first_card(soup, base_url) or _json_ld_latest(soup, base_url)


def _retry_after(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return max(1, int(value))
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            return max(1, int((date - datetime.now(UTC)).total_seconds()))
        except (TypeError, ValueError, OverflowError):
            return None


class AvitoSource:
    """Fetch only the configured search page and return its first result.

    The request is intentionally ordinary and low-frequency. It does not rotate IPs,
    bypass CAPTCHA, impersonate a browser, or retry access blocks.
    """

    def __init__(self, url: str, user_agent: str, timeout_seconds: int) -> None:
        self.url = url
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=True,
            headers={
                "User-Agent": user_agent,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
            },
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def latest(
        self,
        etag: str | None,
        last_modified: str | None,
        *,
        conditional: bool = True,
    ) -> LatestResult:
        headers: dict[str, str] = {}
        if conditional and etag:
            headers["If-None-Match"] = etag
        if conditional and last_modified:
            headers["If-Modified-Since"] = last_modified
        try:
            response = await self.client.get(self.url, headers=headers)
        except httpx.TimeoutException as exc:
            raise TemporarySourceError("Avito не ответил вовремя") from exc
        except httpx.HTTPError as exc:
            raise TemporarySourceError(f"Ошибка соединения с Avito: {exc}") from exc

        if response.status_code == 304:
            return LatestResult(None, etag, last_modified, not_modified=True)
        if response.status_code == 429:
            raise RateLimited("Avito вернул 429 Too Many Requests", _retry_after(response.headers.get("Retry-After")))
        if response.status_code in {401, 403}:
            raise AccessBlocked(
                f"Avito отклонил запрос ({response.status_code}); проверка приостановлена"
            )
        if response.status_code >= 500:
            raise TemporarySourceError(f"Avito временно недоступен ({response.status_code})")
        if response.status_code != 200:
            raise SourceError(f"Avito вернул HTTP {response.status_code}")

        response_host = (response.url.host or "").lower().rstrip(".")
        if response_host != "avito.ru" and not response_host.endswith(".avito.ru"):
            raise AccessBlocked("Avito перенаправил запрос на недопустимый адрес")
        content_type = response.headers.get("content-type", "")
        if content_type and "html" not in content_type.lower():
            raise SourceError(f"Ожидалась HTML-страница, получен {content_type}")

        text = response.text
        lowered = text.lower()
        if any(marker in lowered for marker in ("captcha", "доступ ограничен", "access denied")):
            raise AccessBlocked("Avito показал страницу проверки доступа")
        return LatestResult(
            parse_latest(text, str(response.url)),
            response.headers.get("ETag") or etag,
            response.headers.get("Last-Modified") or last_modified,
        )
