"""APScheduler for WebDAV/S3 backups and soft-delete GC."""

from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler

logger = logging.getLogger("markhub.scheduler")
_scheduler: AsyncIOScheduler | None = None

# Documented backup schedule timezone (F-007)
BACKUP_TZ = ZoneInfo("Asia/Shanghai")


def _local_hhmm() -> str:
    return datetime.now(BACKUP_TZ).strftime("%H:%M")



async def _run_soft_delete_gc() -> dict:
    """Permanently purge soft-deleted bookmarks/folders older than 30 days (F005)."""
    from datetime import timedelta

    from sqlalchemy import delete, select

    from app.database import async_session_maker
    from app.models import Bookmark, BookmarkTag, Folder
    from app.utils.timeutil import server_now

    cutoff = server_now() - timedelta(days=30)
    bm_count = 0
    fd_count = 0
    async with async_session_maker() as db:
        stale_bms = list(
            (
                await db.execute(
                    select(Bookmark).where(
                        Bookmark.deleted_at.is_not(None),
                        Bookmark.deleted_at < cutoff,
                    )
                )
            )
            .scalars()
            .all()
        )
        for b in stale_bms:
            await db.execute(delete(BookmarkTag).where(BookmarkTag.bookmark_id == b.id))
            await db.delete(b)
            bm_count += 1
        stale_fds = list(
            (
                await db.execute(
                    select(Folder).where(
                        Folder.deleted_at.is_not(None),
                        Folder.deleted_at < cutoff,
                        Folder.is_system.is_(False),
                    )
                )
            )
            .scalars()
            .all()
        )
        pending = {f.id for f in stale_fds}
        while pending:
            # Self-referential FKs require physical deletion from leaves to
            # roots. A live/recent child intentionally keeps its parent.
            parent_ids = {
                parent_id
                for parent_id in (
                    await db.execute(select(Folder.parent_id).where(Folder.parent_id.in_(pending)))
                ).scalars()
                if parent_id is not None
            }
            leaves = pending - parent_ids
            if not leaves:
                # Corrupt cycles cannot be safely purged with FK checks on.
                break
            result = await db.execute(delete(Folder).where(Folder.id.in_(leaves)))
            fd_count += result.rowcount or 0
            pending -= leaves
        await db.commit()
    logger.info("soft-delete GC: bookmarks=%s folders=%s", bm_count, fd_count)
    return {"bookmarks": bm_count, "folders": fd_count}


async def _run_scheduled_backups() -> None:
    from sqlalchemy import select

    from app.database import async_session_maker
    from app.domain import remote_backup as remote
    from app.domain.settings_svc import get_json_setting
    from app.models import User

    hhmm = _local_hhmm()
    # Daily GC around 03:15 Asia/Shanghai
    if hhmm == "03:15":
        try:
            await _run_soft_delete_gc()
        except Exception as e:
            logger.warning("soft-delete GC failed: %s", e)
    async with async_session_maker() as db:
        users = (await db.execute(select(User))).scalars().all()
        for u in users:
            try:
                s3 = await get_json_setting(db, u.id, "s3_config", {}) or {}
                if s3.get("enabled") and (s3.get("backup_time") or "02:00") == hhmm:
                    await remote.run_s3_backup(db, u.id)
                    logger.info("S3 backup done for user %s", u.id)
            except Exception as e:
                logger.warning("S3 backup failed: %s", e)
            try:
                dav = await get_json_setting(db, u.id, "webdav_config", {}) or {}
                if dav.get("enabled") and (dav.get("backup_time") or "02:00") == hhmm:
                    await remote.run_webdav_backup(db, u.id)
                    logger.info("WebDAV backup done for user %s", u.id)
            except Exception as e:
                logger.warning("WebDAV backup failed: %s", e)
        await db.commit()


def init_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler(timezone=BACKUP_TZ)
    _scheduler.add_job(_run_scheduled_backups, "cron", minute="*", timezone=BACKUP_TZ)
    _scheduler.start()
    logger.info("Scheduler started (timezone=Asia/Shanghai)")


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None


# Public alias for tests / manual ops
run_soft_delete_gc = _run_soft_delete_gc
