from app.database import Database


def test_database_subscriptions_and_state(tmp_path) -> None:
    database = Database(tmp_path / "bot.sqlite3")

    database.subscribe(42)
    assert database.subscribers() == [42]
    database.put("last_listing_id", "123")
    assert database.get("last_listing_id") == "123"

    database.unsubscribe(42)
    assert database.subscribers() == []
    database.close()
