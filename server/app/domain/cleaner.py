from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import timedelta
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.oplog import write_op
from app.jobs.runner import enqueue
from app.models import Bookmark, CleanIssue, CleanJob, Folder
from app.utils.errors import not_found
from app.utils.normalize import normalize_url
from app.utils.ssrf import assert_safe_url, safe_fetch
from app.utils.timeutil import server_now

logger = logging.getLogger("markhub.cleaner")


async def create_clean_job(
    db: AsyncSession,
    user_id: str,
    *,
    check_invalid: bool = False,
    concurrency: int = 8,
) -> dict:
    """Persist a clean job and process it on the background runner (F-016).

    Local-only scans (no network) are still executed promptly via the runner so
    callers can poll GET /clean/jobs/{id}. Network invalid checks always run
    out-of-band so the request returns immediately.
    """
    job = CleanJob(
        user_id=user_id,
        status="pending",
        check_invalid=check_invalid,
        concurrency=max(1, min(concurrency, 16)),
        progress=0.0,
        created_at=server_now(),
    )
    db.add(job)
    await db.flush()
    job_id = job.id
    await db.commit()

    # Enqueue durable background work (new session)
    enqueue(_run_clean_job(job_id, user_id))

    # For non-network scans, wait briefly so typical small libraries finish before return
    # (keeps API ergonomics / existing tests while still using the job path).
    if not check_invalid:
        for _ in range(50):
            await asyncio.sleep(0.02)
            async with _session() as s:
                row = (
                    await s.execute(select(CleanJob).where(CleanJob.id == job_id))
                ).scalar_one_or_none()
                if row and row.status in ("done", "failed"):
                    return await get_clean_job(s, user_id, job_id)

    return {
        "id": job_id,
        "status": "pending",
        "issue_count": 0,
        "issues": [],
        "progress": 0.0,
    }


def _session():
    from app.database import async_session_maker

    return async_session_maker()


async def _run_clean_job(job_id: str, user_id: str) -> None:
    async with _session() as db:
        try:
            job = (
                await db.execute(
                    select(CleanJob).where(CleanJob.id == job_id, CleanJob.user_id == user_id)
                )
            ).scalar_one_or_none()
            if not job:
                return
            job.status = "running"
            job.progress = 0.05
            await db.commit()

            await _execute_scan(db, job)
            await db.commit()
        except Exception as e:
            logger.exception("clean job %s failed", job_id)
            try:
                job = (
                    await db.execute(select(CleanJob).where(CleanJob.id == job_id))
                ).scalar_one_or_none()
                if job:
                    job.status = "failed"
                    job.finished_at = server_now()
                    await db.commit()
            except Exception:
                pass
            raise e


async def _execute_scan(db: AsyncSession, job: CleanJob) -> None:
    user_id = job.user_id
    check_invalid = bool(job.check_invalid)
    issues: list[CleanIssue] = []
    bookmarks = list(
        (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.user_id == user_id, Bookmark.deleted_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    folders = list(
        (
            await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id, Folder.deleted_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )

    # broken-url
    for b in bookmarks:
        try:
            p = urlparse(b.url if "://" in b.url else f"https://{b.url}")
            if p.scheme not in ("http", "https") or not p.netloc:
                issues.append(
                    CleanIssue(
                        job_id=job.id,
                        user_id=user_id,
                        kind="broken-url",
                        entity_type="bookmark",
                        entity_id=b.id,
                        detail=f"Invalid URL: {b.url}",
                        created_at=server_now(),
                    )
                )
        except Exception:
            issues.append(
                CleanIssue(
                    job_id=job.id,
                    user_id=user_id,
                    kind="broken-url",
                    entity_type="bookmark",
                    entity_id=b.id,
                    detail="URL parse error",
                    created_at=server_now(),
                )
            )

    # duplicates — issue points to non-canonical (keep oldest)
    by_norm: dict[str, list[Bookmark]] = defaultdict(list)
    for b in bookmarks:
        by_norm[b.url_normalized or normalize_url(b.url)].append(b)
    for norm, group in by_norm.items():
        if len(group) < 2:
            continue
        ordered = sorted(group, key=lambda x: x.created_at or server_now())
        for dup in ordered[1:]:
            issues.append(
                CleanIssue(
                    job_id=job.id,
                    user_id=user_id,
                    kind="duplicate",
                    entity_type="bookmark",
                    entity_id=dup.id,
                    detail=f"Duplicate of {ordered[0].id} ({norm})",
                    created_at=server_now(),
                )
            )

    # empty folders (exclude system)
    bm_count: dict[str, int] = defaultdict(int)
    for b in bookmarks:
        bm_count[b.folder_id] += 1
    child_count: dict[str | None, int] = defaultdict(int)
    for f in folders:
        child_count[f.parent_id] += 1
    for f in folders:
        if f.is_system:
            continue
        if bm_count.get(f.id, 0) == 0 and child_count.get(f.id, 0) == 0:
            issues.append(
                CleanIssue(
                    job_id=job.id,
                    user_id=user_id,
                    kind="empty-folder",
                    entity_type="folder",
                    entity_id=f.id,
                    detail=f"Empty folder: {f.name}",
                    created_at=server_now(),
                )
            )

    job.progress = 0.4
    await db.flush()

    # invalid link network check (optional)
    if check_invalid:
        sem = asyncio.Semaphore(job.concurrency)

        async def check_one(b: Bookmark) -> CleanIssue | None:
            ok, reason = assert_safe_url(b.url if "://" in b.url else f"https://{b.url}")
            if not ok:
                return CleanIssue(
                    job_id=job.id,
                    user_id=user_id,
                    kind="invalid",
                    entity_type="bookmark",
                    entity_id=b.id,
                    detail=reason,
                    created_at=server_now(),
                )
            async with sem:
                try:
                    url = b.url if "://" in b.url else f"https://{b.url}"
                    r = await safe_fetch(url, method="HEAD", timeout=8.0, max_redirects=3)
                    if r.status_code >= 400:
                        r = await safe_fetch(
                            url, method="GET", timeout=8.0, max_redirects=3
                        )
                    if r.status_code >= 400:
                        return CleanIssue(
                            job_id=job.id,
                            user_id=user_id,
                            kind="invalid",
                            entity_type="bookmark",
                            entity_id=b.id,
                            detail=f"HTTP {r.status_code}",
                            created_at=server_now(),
                        )
                except Exception as e:
                    return CleanIssue(
                        job_id=job.id,
                        user_id=user_id,
                        kind="invalid",
                        entity_type="bookmark",
                        entity_id=b.id,
                        detail=str(e)[:200],
                        created_at=server_now(),
                    )
            return None

        results = await asyncio.gather(*[check_one(b) for b in bookmarks])
        for iss in results:
            if iss:
                issues.append(iss)

    for iss in issues:
        db.add(iss)
    job.status = "done"
    job.progress = 1.0
    job.finished_at = server_now()
    await db.flush()


async def get_clean_job(db: AsyncSession, user_id: str, job_id: str) -> dict:
    job = (
        await db.execute(
            select(CleanJob).where(CleanJob.id == job_id, CleanJob.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not job:
        raise not_found("Job not found")
    issues = list(
        (
            await db.execute(
                select(CleanIssue).where(CleanIssue.job_id == job_id)
            )
        )
        .scalars()
        .all()
    )
    return {
        "id": job.id,
        "status": job.status,
        "progress": job.progress,
        "check_invalid": job.check_invalid,
        "issue_count": len(issues),
        "issues": [
            {
                "id": i.id,
                "kind": i.kind,
                "entity_type": i.entity_type,
                "entity_id": i.entity_id,
                "detail": i.detail,
                "resolved": i.resolved,
            }
            for i in issues
        ],
    }


async def apply_clean(
    db: AsyncSession,
    user_id: str,
    issue_ids: list[str],
    *,
    mark_link_status: bool = False,
) -> dict:
    applied = 0
    for iid in issue_ids:
        issue = (
            await db.execute(
                select(CleanIssue).where(
                    CleanIssue.id == iid, CleanIssue.user_id == user_id
                )
            )
        ).scalar_one_or_none()
        if not issue or issue.resolved:
            continue
        now = server_now()
        if issue.entity_type == "bookmark":
            b = (
                await db.execute(
                    select(Bookmark).where(
                        Bookmark.id == issue.entity_id, Bookmark.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
            if b and b.deleted_at is None:
                b.deleted_at = now
                b.updated_at = now
                if mark_link_status:
                    b.link_status = "broken"
                await write_op(
                    db, user_id, "bookmark", b.id, "soft_delete", {"from": "clean"}
                )
                applied += 1
        elif issue.entity_type == "folder":
            f = (
                await db.execute(
                    select(Folder).where(
                        Folder.id == issue.entity_id, Folder.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
            if f and not f.is_system and f.deleted_at is None:
                f.deleted_at = now
                f.updated_at = now
                await write_op(
                    db, user_id, "folder", f.id, "soft_delete", {"from": "clean"}
                )
                applied += 1
        issue.resolved = True
    await db.flush()
    return {"ok": True, "applied": applied}


async def analytics_profile(db: AsyncSession, user_id: str) -> dict:
    bookmarks = list(
        (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.user_id == user_id, Bookmark.deleted_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    folders = list(
        (
            await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id, Folder.deleted_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    domains: dict[str, int] = defaultdict(int)
    for b in bookmarks:
        try:
            host = urlparse(b.url if "://" in b.url else f"https://{b.url}").hostname or ""
            host = host.lower().removeprefix("www.")
            if host:
                domains[host] += 1
        except Exception:
            pass
    top_domains = sorted(domains.items(), key=lambda x: -x[1])[:20]
    cutoff = server_now() - timedelta(days=30)
    recent = sum(1 for b in bookmarks if b.created_at and b.created_at >= cutoff)
    return {
        "total_bookmarks": len(bookmarks),
        "total_folders": len(folders),
        "top_domains": [{"domain": d, "count": c} for d, c in top_domains],
        "added_last_30_days": recent,
        "favorites": sum(1 for b in bookmarks if b.is_favorite),
        "archived": sum(1 for b in bookmarks if b.is_archived),
        "by_visibility": {
            "public": sum(1 for b in bookmarks if b.visibility == "public"),
            "unlisted": sum(1 for b in bookmarks if b.visibility == "unlisted"),
            "private": sum(1 for b in bookmarks if b.visibility == "private"),
        },
    }
