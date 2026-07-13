from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.oplog import write_op
from app.domain.serializers import tag_dict
from app.models import BookmarkTag, Tag
from app.utils.errors import api_error, not_found
from app.utils.timeutil import server_now


async def list_tags(db: AsyncSession, user_id: str) -> list[dict]:
    rows = (
        await db.execute(
            select(Tag).where(Tag.user_id == user_id).order_by(Tag.name)
        )
    ).scalars().all()
    return [tag_dict(t) for t in rows]


async def create_tag(
    db: AsyncSession, user_id: str, name: str, color: str | None = None
) -> dict:
    name = (name or "").strip()
    if not name:
        raise api_error("validation", "name is required")
    existing = (
        await db.execute(select(Tag).where(Tag.user_id == user_id, Tag.name == name))
    ).scalar_one_or_none()
    if existing:
        return tag_dict(existing)
    now = server_now()
    t = Tag(user_id=user_id, name=name, color=color, created_at=now, updated_at=now)
    db.add(t)
    await db.flush()
    await write_op(db, user_id, "tag", t.id, "create", tag_dict(t))
    return tag_dict(t)


async def update_tag(
    db: AsyncSession, user_id: str, tag_id: str, name: str | None = None, color: str | None = None
) -> dict:
    t = (
        await db.execute(select(Tag).where(Tag.id == tag_id, Tag.user_id == user_id))
    ).scalar_one_or_none()
    if not t:
        raise not_found("Tag not found")
    if name is not None:
        t.name = name.strip() or t.name
    if color is not None:
        t.color = color
    t.updated_at = server_now()
    await db.flush()
    await write_op(db, user_id, "tag", t.id, "update", tag_dict(t))
    return tag_dict(t)


async def delete_tag(db: AsyncSession, user_id: str, tag_id: str) -> dict:
    t = (
        await db.execute(select(Tag).where(Tag.id == tag_id, Tag.user_id == user_id))
    ).scalar_one_or_none()
    if not t:
        raise not_found("Tag not found")
    await db.execute(select(BookmarkTag).where(BookmarkTag.tag_id == tag_id))
    from sqlalchemy import delete

    await db.execute(delete(BookmarkTag).where(BookmarkTag.tag_id == tag_id))
    await db.delete(t)
    await db.flush()
    await write_op(db, user_id, "tag", tag_id, "delete", {"id": tag_id})
    return {"ok": True, "id": tag_id}
