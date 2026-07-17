from __future__ import annotations

import logging
import secrets
import time
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Bookmark, Folder, RateLimit, ShareLink
from app.security.auth import hash_password, verify_password
from app.utils.errors import api_error, not_found
from app.utils.timeutil import iso, server_now

logger = logging.getLogger("markhub.shares")

_MAX_ATTEMPTS = 10
_WINDOW_SEC = 300


def _as_naive_utc(dt: datetime | None) -> datetime | None:
    """Normalize API timestamps to naive UTC for SQLite storage / comparison."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _throttle_key(token: str, client_ip: str | None) -> str:
    return f"share_unlock:{token}|{client_ip or 'unknown'}"


def _throttle_keys(token: str, client_ip: str | None) -> tuple[str, str]:
    return (f"share_unlock:{token}|all", _throttle_key(token, client_ip))


async def _check_rate_limit(db: AsyncSession, token: str, client_ip: str | None) -> None:
    """Durable DB-backed rate limit (R4-F012)."""
    now = time.time()
    rows = (
        await db.execute(
            select(RateLimit).where(RateLimit.key.in_(_throttle_keys(token, client_ip)))
        )
    ).scalars().all()
    for row in rows:
        if (now - float(row.window_start)) < _WINDOW_SEC and row.count >= _MAX_ATTEMPTS:
            logger.warning(
                "share_unlock_throttled token_prefix=%s ip=%s",
                token[:6],
                client_ip or "-",
            )
            raise api_error("rate_limited", "Too many unlock attempts; try again later", 429)


async def _record_failed_attempt(
    db: AsyncSession, token: str, client_ip: str | None
) -> None:
    """Persist failed-attempt counts so HTTP error rollbacks cannot erase them."""
    now = time.time()
    keys = _throttle_keys(token, client_ip)
    rows = (
        await db.execute(select(RateLimit).where(RateLimit.key.in_(keys)))
    ).scalars().all()
    rows_by_key = {row.key: row for row in rows}
    for key in keys:
        row = rows_by_key.get(key)
        if not row or (now - float(row.window_start)) >= _WINDOW_SEC:
            if row:
                row.window_start = now
                row.count = 1
            else:
                db.add(RateLimit(key=key, window_start=now, count=1))
        else:
            row.count = int(row.count) + 1
    # Commit counter out-of-band so subsequent 401/429 paths keep the tally
    await db.commit()


async def create_share(
    db: AsyncSession,
    user_id: str,
    *,
    target_type: str,
    target_id: str,
    password: str | None = None,
    expires_at: datetime | None = None,
) -> dict:
    if target_type not in ("folder", "bookmark"):
        raise api_error("validation", "invalid target_type")
    expires_norm = _as_naive_utc(expires_at)
    token = secrets.token_urlsafe(16)
    link = ShareLink(
        user_id=user_id,
        token=token,
        target_type=target_type,
        target_id=target_id,
        password_hash=hash_password(password) if password else None,
        expires_at=expires_norm,
        created_at=server_now(),
    )
    db.add(link)
    await db.flush()
    return {
        "id": link.id,
        "token": token,
        "target_type": target_type,
        "target_id": target_id,
        "has_password": bool(password),
        "expires_at": iso(expires_norm),
        "url_path": f"/s/{token}",
    }


async def list_shares(db: AsyncSession, user_id: str) -> list[dict]:
    rows = (
        await db.execute(
            select(ShareLink)
            .where(ShareLink.user_id == user_id)
            .order_by(ShareLink.created_at.desc())
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "token": r.token,
            "target_type": r.target_type,
            "target_id": r.target_id,
            "has_password": bool(r.password_hash),
            "expires_at": iso(r.expires_at),
            "url_path": f"/s/{r.token}",
        }
        for r in rows
    ]


async def get_share(
    db: AsyncSession,
    token: str,
    password: str | None = None,
    *,
    client_ip: str | None = None,
    allow_query_password: bool = False,
) -> dict:
    """
    Resolve a share link.

    Password unlock should use POST body (F-018). Query-string passwords are
    rejected unless allow_query_password is explicitly enabled for legacy tests.
    """
    link = (
        await db.execute(select(ShareLink).where(ShareLink.token == token))
    ).scalar_one_or_none()
    if not link:
        raise not_found("Share not found")
    if link.expires_at and link.expires_at < server_now():
        raise api_error("expired", "Share link expired", 410)
    if link.password_hash:
        if password is None:
            raise api_error("password_required", "Password required", 401)
        if not allow_query_password and password == "":
            raise api_error("password_required", "Password required", 401)
        await _check_rate_limit(db, token, client_ip)
        if not verify_password(password, link.password_hash):
            await _record_failed_attempt(db, token, client_ip)
            logger.info(
                "share_unlock_failed token_prefix=%s ip=%s",
                token[:6],
                client_ip or "-",
            )
            raise api_error("password_required", "Password required or incorrect", 401)
        logger.info(
            "share_unlock_ok token_prefix=%s ip=%s",
            token[:6],
            client_ip or "-",
        )

    payload: dict = {
        "target_type": link.target_type,
        "target_id": link.target_id,
    }
    # Shared targets must be live rows owned by the share creator (RQG-SHARE-001).
    # Soft-deleted or missing entities must not leak title/url via public share URLs.
    if link.target_type == "bookmark":
        b = (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.id == link.target_id,
                    Bookmark.user_id == link.user_id,
                    Bookmark.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if not b:
            raise not_found("Share target not found")
        payload["bookmark"] = {
            "title": b.title,
            "url": b.url,
            "description": b.description,
        }
    elif link.target_type == "folder":
        f = (
            await db.execute(
                select(Folder).where(
                    Folder.id == link.target_id,
                    Folder.user_id == link.user_id,
                    Folder.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if not f:
            raise not_found("Share target not found")
        payload["folder"] = {"name": f.name, "id": f.id}
        bms = (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.folder_id == f.id,
                    Bookmark.user_id == link.user_id,
                    Bookmark.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        payload["bookmarks"] = [
            {"title": b.title, "url": b.url, "description": b.description} for b in bms
        ]
    return payload


async def delete_share(db: AsyncSession, user_id: str, token: str) -> dict:
    link = (
        await db.execute(
            select(ShareLink).where(ShareLink.token == token, ShareLink.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not link:
        raise not_found("Share not found")
    await db.delete(link)
    await db.flush()
    return {"ok": True, "token": token}
