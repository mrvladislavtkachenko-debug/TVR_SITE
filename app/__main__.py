from __future__ import annotations

import asyncio
import logging
import sys

from .bot import run_bot
from .config import ConfigurationError, Settings

logger = logging.getLogger(__name__)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(run_bot(Settings.from_env()))
    except ConfigurationError as exc:
        logger.error("Ошибка конфигурации: %s", exc)
        sys.exit(2)
    except KeyboardInterrupt:
        logger.info("Остановка по Ctrl+C")


if __name__ == "__main__":
    main()
