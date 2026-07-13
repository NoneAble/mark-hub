"""Background job runner for cleaner / AI batch (F-016)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger("markhub.jobs")

# Bounded in-process worker set
_sem = asyncio.Semaphore(2)
_tasks: set[asyncio.Task[Any]] = set()


def enqueue(coro) -> None:
    """Schedule a coroutine; does not block the request path."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("No running loop; job not enqueued")
        return

    async def _wrapped():
        async with _sem:
            try:
                await coro
            except Exception:
                logger.exception("Background job failed")

    task = loop.create_task(_wrapped())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
