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


def _meta(soup: BeautifulSoup, *, name: str | None = None, prop: str | None = None) -> str | None:
    attributes = {"name": name} if name else {"property": prop}
    element = soup.find("meta", attrs=attributes)
    return _text(element.get("content")) if element else None


def _avito_url(href: str, base_url: str, *, allow_root: bool = False) -> str | None:
    absolute = urljoin(base_url, href)
    parts = urlsplit(absolute)
    hostname = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme != "https" or (hostname != "avito.ru" and not hostname.endswith(".avito.ru")):
        return None
    if not allow_root and not parts.path:
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


def _marked_text(container: Tag, *markers: str, limit: int = 500) -> str | None:
    for marker in markers:
        element = container.find(attrs={"data-marker": marker})
        if element is not None:
            return _text(element.get_text(" ", strip=True), limit)
    return None


def _image(container: Tag | BeautifulSoup, base_url: str) -> str | None:
    image = container.find("img")
    if image is None:
        return None
    for attribute in ("src", "data-src", "data-original"):
        value = image.get(attribute)
        if isinstance(value, str):
            return _avito_url(value, base_url)
    srcset = image.get("srcset")
    if isinstance(srcset, str):
        value = srcset.split(",", 1)[0].strip().split(" ", 1)[0]
        return _avito_url(value, base_url)
    return None


def _first_card(soup: BeautifulSoup, base_url: str) -> LatestListing | None:
    anchor = soup.select_one('a[data-marker="item-title"]')
    if anchor is None:
        # Fallback for a few older layouts. It is limited to item-looking links and
        # cannot select an arbitrary navigation link as the result.
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
        image_url=_image(card, base_url),
    )


def _json_objects(soup: BeautifulSoup) -> list[dict]:
    objects: list[dict] = []
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(script.string or script.get_text())
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        values = data if isinstance(data, list) else [data]
        objects.extend(value for value in values if isinstance(value, dict))
    return objects


def _json_ld_latest(soup: BeautifulSoup, base_url: str) -> LatestListing | None:
    """Fallback for search pages exposing the first result in JSON-LD."""
    for obj in _json_objects(soup):
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
            image = item.get("image")
            if isinstance(image, list):
                image = image[0] if image else None
            return LatestListing(
                listing_id=_id_for(url),
                title=_text(item["name"]) or "Без названия",
                url=url,
                price=_text(str(price)) if price is not None else None,
                published_at=_text(str(item.get("datePublished"))) if item.get("datePublished") else None,
                description=_text(item.get("description"), 2000),
                image_url=_avito_url(image, base_url) if isinstance(image, str) else None,
            )
    return None


def parse_latest(html: str, base_url: str) -> LatestListing | None:
    soup = BeautifulSoup(html, "html.parser")
    return _first_card(soup, base_url) or _json_ld_latest(soup, base_url)


def _detail_json(soup: BeautifulSoup, base_url: str) -> LatestListing | None:
    for obj in _json_objects(soup):
        obj_type = obj.get("@type")
        if obj_type != "Product" and not (
            isinstance(obj_type, list) and "Product" in obj_type
        ):
            continue
        url = obj.get("url")
        if not isinstance(url, str):
            url = base_url
        canonical = _avito_url(url, base_url, allow_root=True) or base_url
        offers = obj.get("offers") if isinstance(obj.get("offers"), dict) else {}
        price = offers.get("price")
        if price is not None:
            price = f"{price} {offers.get('priceCurrency', 'RUB')}"
        seller = obj.get("seller") if isinstance(obj.get("seller"), dict) else {}
        image = obj.get("image")
        if isinstance(image, list):
            image = image[0] if image else None
        return LatestListing(
            listing_id=_id_for(base_url),
            title=_text(obj.get("name")) or "Без названия",
            url=canonical,
            price=_text(str(price)) if price is not None else None,
            published_at=_text(str(obj.get("datePublished"))) if obj.get("datePublished") else None,
            description=_text(obj.get("description"), 2000),
            seller=_text(seller.get("name")) if isinstance(seller, dict) else None,
            seller_url=_avito_url(seller.get("url"), base_url) if isinstance(seller, dict) and isinstance(seller.get("url"), str) else None,
            image_url=_avito_url(image, base_url) if isinstance(image, str) else None,
        )
    return None


def _detail_marked(soup: BeautifulSoup, selectors: tuple[str, ...], limit: int = 500) -> str | None:
    for selector in selectors:
        element = soup.select_one(selector)
        if element is None:
            continue
        if element.name == "meta" or element.name == "time":
            value = element.get("content") or element.get("datetime")
        else:
            value = element.get_text(" ", strip=True)
        result = _text(value, limit)
        if result:
            return result
    return None


def parse_detail(html: str, listing: LatestListing) -> LatestListing:
    soup = BeautifulSoup(html, "html.parser")
    structured = _detail_json(soup, listing.url)
    detail = structured or LatestListing(listing.listing_id, listing.title, listing.url)
    description = _detail_marked(
        soup,
        (
            '[data-marker="item-description"]',
            '[data-marker="item-description-text"]',
            '[itemprop="description"]',
            'meta[property="og:description"]',
            'meta[name="description"]',
        ),
        limit=2000,
    )
    title = _detail_marked(soup, ('h1', 'meta[property="og:title"]'))
    price = _detail_marked(soup, ('[data-marker="item-price"]', '[itemprop="price"]'))
    location = _detail_marked(
        soup,
        ('[data-marker="item-address"]', '[data-marker="item-location"]', '[itemprop="address"]'),
    )
    published = _detail_marked(
        soup,
        ('[data-marker="item-date"]', 'time[datetime]', 'meta[property="article:published_time"]'),
    )
    seller_element = soup.select_one(
        '[data-marker="seller-info/name"], [data-marker="seller-name"], '
        '[data-marker="profile-link"], [itemprop="seller"]'
    )
    seller = _text(seller_element.get_text(" ", strip=True)) if seller_element else None
    seller_url = None
    if seller_element is not None:
        seller_anchor = seller_element if seller_element.name == "a" else seller_element.find("a")
        if seller_anchor is not None and isinstance(seller_anchor.get("href"), str):
            seller_url = _avito_url(seller_anchor["href"], listing.url)
    image_url = _meta(soup, prop="og:image")
    image_url = _avito_url(image_url, listing.url) if image_url else _image(soup, listing.url)
    detail = LatestListing(
        listing_id=listing.listing_id,
        title=title or detail.title,
        url=listing.url,
        price=price or detail.price,
        location=location or detail.location,
        published_at=published or detail.published_at,
        description=description or detail.description,
        seller=seller or detail.seller,
        seller_url=seller_url or detail.seller_url,
        image_url=image_url or detail.image_url,
    )
    return listing.merged(detail)


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
    """Fetch the first result and, only when needed, one detail page.

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

    def _check_response(self, response: httpx.Response) -> None:
        if response.status_code == 429:
            raise RateLimited(
                "Avito вернул 429 Too Many Requests",
                _retry_after(response.headers.get("Retry-After")),
            )
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
        lowered = response.text.lower()
        if any(marker in lowered for marker in ("captcha", "доступ ограничен", "access denied")):
            raise AccessBlocked("Avito показал страницу проверки доступа")

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
        self._check_response(response)
        return LatestResult(
            parse_latest(response.text, str(response.url)),
            response.headers.get("ETag") or etag,
            response.headers.get("Last-Modified") or last_modified,
        )

    async def enrich(self, listing: LatestListing) -> LatestListing:
        """Read the item page once to add description, seller and photo."""
        try:
            response = await self.client.get(listing.url)
        except httpx.TimeoutException as exc:
            raise TemporarySourceError("Страница объявления не ответила вовремя") from exc
        except httpx.HTTPError as exc:
            raise TemporarySourceError(f"Ошибка загрузки объявления: {exc}") from exc
        self._check_response(response)
        return parse_detail(response.text, listing)
