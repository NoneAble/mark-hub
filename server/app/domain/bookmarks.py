from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.folders import get_folder
from app.domain.oplog import write_op
from app.domain.serializers import bookmark_dict
from app.models import Bookmark, BookmarkTag, ReorderClock, Tag
from app.utils.errors import api_error, not_found
from app.utils.normalize import normalize_url
from app.utils.timeutil import server_now


async def _tags_for(db: AsyncSession, bookmark_id: str) -> list[Tag]:
    q = (
        select(Tag)
        .join(BookmarkTag, BookmarkTag.tag_id == Tag.id)
        .where(BookmarkTag.bookmark_id == bookmark_id)
    )
    return list((await db.execute(q)).scalars().all())


async def _tags_for_many(
    db: AsyncSession, bookmark_ids: list[str]
) -> dict[str, list[Tag]]:
    """Batch-load tags for many bookmarks (F015 — avoid N+1)."""
    out: dict[str, list[Tag]] = {bid: [] for bid in bookmark_ids}
    if not bookmark_ids:
        return out
    # Chunk to stay under SQLite variable limits
    chunk_size = 400
    for i in range(0, len(bookmark_ids), chunk_size):
        chunk = bookmark_ids[i : i + chunk_size]
        q = (
            select(BookmarkTag.bookmark_id, Tag)
            .join(Tag, Tag.id == BookmarkTag.tag_id)
            .where(BookmarkTag.bookmark_id.in_(chunk))
            .order_by(Tag.name)
        )
        for bid, tag in (await db.execute(q)).all():
            out.setdefault(bid, []).append(tag)
    return out


async def _set_tags(
    db: AsyncSession, user_id: str, bookmark_id: str, tag_names: list[str]
) -> list[Tag]:
    await db.execute(delete(BookmarkTag).where(BookmarkTag.bookmark_id == bookmark_id))
    tags: list[Tag] = []
    for name in tag_names:
        name = name.strip()
        if not name:
            continue
        t = (
            await db.execute(
                select(Tag).where(Tag.user_id == user_id, Tag.name == name)
            )
        ).scalar_one_or_none()
        if t is None:
            now = server_now()
            t = Tag(user_id=user_id, name=name, created_at=now, updated_at=now)
            db.add(t)
            await db.flush()
        db.add(BookmarkTag(bookmark_id=bookmark_id, tag_id=t.id))
        tags.append(t)
    await db.flush()
    return tags


async def list_bookmarks(
    db: AsyncSession,
    user_id: str,
    *,
    folder_id: str | None = None,
    q: str | None = None,
    include_archived: bool = True,
    include_deleted: bool = False,
    visibility: str | None = None,
    limit: int = 500,
    offset: int = 0,
    max_limit: int | None = 1000,
) -> dict:
    """List bookmarks. Pass max_limit=None for full export (F-005)."""
    query = select(Bookmark).where(Bookmark.user_id == user_id)
    if not include_deleted:
        query = query.where(Bookmark.deleted_at.is_(None))
    if folder_id:
        query = query.where(Bookmark.folder_id == folder_id)
    if not include_archived:
        query = query.where(Bookmark.is_archived == False)  # noqa: E712
    if visibility:
        query = query.where(Bookmark.visibility == visibility)
    if q:
        fts_ids = await _fts_search_ids(db, user_id, q)
        if fts_ids is not None:
            if not fts_ids:
                return {"items": [], "total": 0, "limit": limit, "offset": offset}
            query = query.where(Bookmark.id.in_(fts_ids))
        else:
            like = f"%{q}%"
            query = query.where(
                or_(
                    Bookmark.title.ilike(like),
                    Bookmark.url.ilike(like),
                    Bookmark.description.ilike(like),
                )
            )
    total = (
        await db.execute(select(func.count()).select_from(query.subquery()))
    ).scalar_one()
    effective_limit = limit if max_limit is None else min(limit, max_limit)
    rows = (
        await db.execute(
            query.order_by(Bookmark.sort_order, Bookmark.created_at.desc())
            .limit(effective_limit)
            .offset(offset)
        )
    ).scalars().all()
    tag_map = await _tags_for_many(db, [b.id for b in rows])
    items = [bookmark_dict(b, tag_map.get(b.id, [])) for b in rows]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


async def iter_all_bookmarks(
    db: AsyncSession,
    user_id: str,
    *,
    include_archived: bool = True,
    include_deleted: bool = False,
    page_size: int = 2000,
) -> list[dict]:
    """Page through the complete live set for backup/export (F-005)."""
    items: list[dict] = []
    offset = 0
    while True:
        page = await list_bookmarks(
            db,
            user_id,
            include_archived=include_archived,
            include_deleted=include_deleted,
            limit=page_size,
            offset=offset,
            max_limit=None,
        )
        batch = page["items"]
        items.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return items


async def _fts_search_ids(
    db: AsyncSession, user_id: str, q: str
) -> list[str] | None:
    """Return bookmark ids from FTS when available; None means fall back to LIKE."""
    from sqlalchemy import text

    from app.config import get_settings

    settings = get_settings()
    term = (q or "").strip()
    if not term:
        return []
    try:
        if "sqlite" in settings.database_url:
            result = await db.execute(
                text(
                    """
                    SELECT b.id FROM bookmarks_fts
                    JOIN bookmarks b ON b.id = bookmarks_fts.bookmark_id
                    WHERE b.user_id = :uid AND b.deleted_at IS NULL
                      AND bookmarks_fts MATCH :q
                    """
                ),
                {"uid": user_id, "q": term},
            )
            return [r[0] for r in result.fetchall()]
        if "postgres" in settings.database_url or "postgresql" in settings.database_url:
            result = await db.execute(
                text(
                    """
                    SELECT id FROM bookmarks
                    WHERE user_id = :uid AND deleted_at IS NULL
                      AND search_vector @@ plainto_tsquery('simple', :q)
                    """
                ),
                {"uid": user_id, "q": term},
            )
            return [r[0] for r in result.fetchall()]
    except Exception:
        return None
    return None


async def sync_bookmark_fts(db: AsyncSession, bookmark: Bookmark, tags: list[str] | None = None) -> None:
    """Keep FTS index in sync with bookmark writes (F-019)."""
    from sqlalchemy import text

    from app.config import get_settings

    settings = get_settings()
    tag_str = " ".join(tags or [])
    try:
        if "sqlite" in settings.database_url:
            await db.execute(
                text("DELETE FROM bookmarks_fts WHERE bookmark_id = :id"),
                {"id": bookmark.id},
            )
            if bookmark.deleted_at is None:
                await db.execute(
                    text(
                        """
                        INSERT INTO bookmarks_fts (bookmark_id, title, url, description, tags)
                        VALUES (:id, :title, :url, :desc, :tags)
                        """
                    ),
                    {
                        "id": bookmark.id,
                        "title": bookmark.title or "",
                        "url": bookmark.url or "",
                        "desc": bookmark.description or "",
                        "tags": tag_str,
                    },
                )
        elif "postgres" in settings.database_url or "postgresql" in settings.database_url:
            await db.execute(
                text(
                    """
                    UPDATE bookmarks SET search_vector =
                      setweight(to_tsvector('simple', coalesce(:title, '')), 'A') ||
                      setweight(to_tsvector('simple', coalesce(:url, '')), 'B') ||
                      setweight(to_tsvector('simple', coalesce(:desc, '')), 'C') ||
                      setweight(to_tsvector('simple', coalesce(:tags, '')), 'C')
                    WHERE id = :id
                    """
                ),
                {
                    "id": bookmark.id,
                    "title": bookmark.title or "",
                    "url": bookmark.url or "",
                    "desc": bookmark.description or "",
                    "tags": tag_str,
                },
            )
    except Exception:
        # FTS is best-effort; LIKE fallback remains
        pass


async def get_bookmark(db: AsyncSession, user_id: str, bookmark_id: str) -> Bookmark:
    b = (
        await db.execute(
            select(Bookmark).where(
                Bookmark.id == bookmark_id,
                Bookmark.user_id == user_id,
                Bookmark.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not b:
        raise not_found("Bookmark not found")
    return b


async def create_bookmark(
    db: AsyncSession,
    user_id: str,
    data: dict[str, Any],
) -> dict:
    url = (data.get("url") or "").strip()
    if not url:
        raise api_error("validation", "url is required")
    folder_id = data.get("folder_id")
    if not folder_id:
        from app.domain.bootstrap import get_inbox_folder_id

        folder_id = await get_inbox_folder_id(db, user_id)
    else:
        await get_folder(db, user_id, folder_id)

    title = (data.get("title") or url).strip()
    now = server_now()
    sort_order = data.get("sort_order")
    if sort_order is None:
        mx = (
            await db.execute(
                select(func.coalesce(func.max(Bookmark.sort_order), -1)).where(
                    Bookmark.user_id == user_id,
                    Bookmark.folder_id == folder_id,
                    Bookmark.deleted_at.is_(None),
                )
            )
        ).scalar_one()
        sort_order = int(mx) + 1

    b = Bookmark(
        user_id=user_id,
        folder_id=folder_id,
        title=title,
        url=url,
        url_normalized=normalize_url(url),
        description=data.get("description"),
        visibility=data.get("visibility")
        if data.get("visibility") in ("private", "unlisted", "public")
        else "private",
        is_favorite=bool(data.get("is_favorite", False)),
        is_archived=bool(data.get("is_archived", False)),
        sort_order=int(sort_order),
        ai_summary=data.get("ai_summary"),
        ai_category=data.get("ai_category"),
        link_status=data.get("link_status") or "unknown",
        created_at=now,
        updated_at=now,
    )
    db.add(b)
    await db.flush()
    tags: list[Tag] = []
    if data.get("tags"):
        tags = await _set_tags(db, user_id, b.id, list(data["tags"]))
    await sync_bookmark_fts(db, b, [t.name for t in tags])
    await write_op(db, user_id, "bookmark", b.id, "create", bookmark_dict(b))
    return bookmark_dict(b, tags)


async def update_bookmark(
    db: AsyncSession, user_id: str, bookmark_id: str, patch: dict[str, Any]
) -> dict:
    b = await get_bookmark(db, user_id, bookmark_id)
    if "title" in patch and patch["title"] is not None:
        b.title = str(patch["title"]).strip() or b.title
    if "url" in patch and patch["url"] is not None:
        b.url = str(patch["url"]).strip()
        b.url_normalized = normalize_url(b.url)
    if "description" in patch:
        b.description = patch["description"]
    if "folder_id" in patch and patch["folder_id"]:
        await get_folder(db, user_id, patch["folder_id"])
        b.folder_id = patch["folder_id"]
    if "visibility" in patch and patch["visibility"] in ("private", "unlisted", "public"):
        b.visibility = patch["visibility"]
    if "is_favorite" in patch:
        b.is_favorite = bool(patch["is_favorite"])
    if "is_archived" in patch:
        b.is_archived = bool(patch["is_archived"])
    if "sort_order" in patch and patch["sort_order"] is not None:
        b.sort_order = int(patch["sort_order"])
    if "ai_summary" in patch:
        b.ai_summary = patch["ai_summary"]
    if "ai_category" in patch:
        b.ai_category = patch["ai_category"]
    if "link_status" in patch and patch["link_status"]:
        b.link_status = patch["link_status"]
    b.updated_at = server_now()
    await db.flush()
    tags = await _tags_for(db, b.id)
    if "tags" in patch and patch["tags"] is not None:
        tags = await _set_tags(db, user_id, b.id, list(patch["tags"]))
    await sync_bookmark_fts(db, b, [t.name for t in tags])
    await write_op(db, user_id, "bookmark", b.id, "update", bookmark_dict(b))
    return bookmark_dict(b, tags)


async def delete_bookmark(db: AsyncSession, user_id: str, bookmark_id: str) -> dict:
    b = await get_bookmark(db, user_id, bookmark_id)
    now = server_now()
    b.deleted_at = now
    b.updated_at = now
    await db.flush()
    await sync_bookmark_fts(db, b)
    await write_op(db, user_id, "bookmark", b.id, "soft_delete", bookmark_dict(b))
    return {"ok": True, "id": bookmark_id}


async def reorder_bookmarks(
    db: AsyncSession,
    user_id: str,
    folder_id: str,
    ordered_ids: list[str],
) -> dict:
    await get_folder(db, user_id, folder_id)
    now = server_now()
    for i, bid in enumerate(ordered_ids):
        b = await get_bookmark(db, user_id, bid)
        b.sort_order = i
        b.folder_id = folder_id
        b.updated_at = now
    clock = (
        await db.execute(
            select(ReorderClock).where(
                ReorderClock.user_id == user_id,
                ReorderClock.scope == "bookmark",
                ReorderClock.parent_id == folder_id,
            )
        )
    ).scalar_one_or_none()
    if clock is None:
        db.add(
            ReorderClock(
                user_id=user_id, scope="bookmark", parent_id=folder_id, updated_at=now
            )
        )
    else:
        clock.updated_at = now
    await db.flush()
    await write_op(
        db,
        user_id,
        "reorder",
        folder_id,
        "reorder",
        {"scope": "bookmark", "parent_id": folder_id, "ordered_ids": ordered_ids},
    )
    return {"ok": True, "ordered_ids": ordered_ids}


async def batch_bookmarks(
    db: AsyncSession, user_id: str, action: str, ids: list[str], payload: dict | None = None
) -> dict:
    """Batch ops. Canonical body uses nested ``payload``; top-level aliases accepted (R4-F014)."""
    payload = dict(payload or {})
    # Tolerate accidental top-level fields from older clients by merging into payload
    # when called via API with a raw body — see BatchBody model_validator.
    results = []
    for bid in ids:
        if action == "delete":
            results.append(await delete_bookmark(db, user_id, bid))
        elif action == "move":
            folder_id = payload.get("folder_id")
            if not folder_id:
                raise api_error("validation", "payload.folder_id is required for move")
            results.append(
                await update_bookmark(db, user_id, bid, {"folder_id": folder_id})
            )
        elif action == "set_visibility":
            visibility = payload.get("visibility")
            if not visibility:
                raise api_error("validation", "payload.visibility is required")
            results.append(
                await update_bookmark(db, user_id, bid, {"visibility": visibility})
            )
        elif action == "set_archived":
            results.append(
                await update_bookmark(
                    db, user_id, bid, {"is_archived": bool(payload.get("is_archived", True))}
                )
            )
        elif action == "set_tags":
            results.append(
                await update_bookmark(db, user_id, bid, {"tags": payload.get("tags", [])})
            )
        else:
            raise api_error("validation", f"Unknown batch action: {action}")
    return {"ok": True, "count": len(results), "affected": len(results), "results": results}


