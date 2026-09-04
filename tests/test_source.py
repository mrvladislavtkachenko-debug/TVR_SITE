from app.source import parse_latest

HTML = """
<html><body>
  <article data-marker="item" data-item-id="123456789">
    <a data-marker="item-title" href="/moskva/velosiped_123456789?utm_source=test">Городской велосипед</a>
    <span data-marker="item-price">25 000 ₽</span>
    <span data-marker="item-address">Москва, центр</span>
    <span data-marker="item-date">сегодня в 12:00</span>
  </article>
  <article data-marker="item" data-item-id="987654321">
    <a data-marker="item-title" href="/moskva/item/987654321">Другой товар</a>
  </article>
</body></html>
"""


def test_returns_only_first_result() -> None:
    listing = parse_latest(HTML, "https://www.avito.ru/moskva?q=велосипед")

    assert listing is not None
    assert listing.listing_id == "123456789"
    assert listing.title == "Городской велосипед"
    assert listing.url == "https://www.avito.ru/moskva/velosiped_123456789"
    assert listing.price == "25 000 ₽"
    assert listing.location == "Москва, центр"
    assert listing.published_at == "сегодня в 12:00"


def test_external_links_are_not_used() -> None:
    listing = parse_latest(
        '<a data-marker="item-title" href="https://example.com/123456">Not Avito</a>',
        "https://www.avito.ru/moskva?q=x",
    )
    assert listing is None


def test_json_ld_fallback() -> None:
    html = """
    <script type="application/ld+json">
      {"itemListElement": [{"item": {
        "name": "Ноутбук", "url": "https://www.avito.ru/moskva/item/555555555",
        "offers": {"price": "50000", "priceCurrency": "RUB"}
      }}]}
    </script>
    """
    listing = parse_latest(html, "https://www.avito.ru/moskva?q=ноутбук")
    assert listing is not None
    assert listing.listing_id == "555555555"
    assert listing.price == "50000 RUB"
