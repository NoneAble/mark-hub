from __future__ import annotations

from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.bootstrap import get_inbox_folder_id
from app.domain.oplog import write_op
from app.domain.serializers import folder_dict
from app.models import Bookmark, Folder, ReorderClock
from app.utils.errors import api_error, not_found
from app.utils.timeutil import server_now

MAX_DEPTH = 32
FolderDeleteMode = Literal["move_to_parent", "move_to_inbox", "cascade_soft_delete"]
FOLDER_DELETE_MODES: frozenset[str] = frozenset(
    ("move_to_parent", "move_to_inbox", "cascade_soft_delete")
)


def validate_folder_delete_mode(mode: str) -> FolderDeleteMode:
    if mode not in FOLDER_DELETE_MODES:
        raise api_error(
            "validation",
            "mode must be one of: move_to_parent, move_to_inbox, cascade_soft_delete",
        )
    return mode  # type: ignore[return-value]


async def list_folders(db: AsyncSession, user_id: str, include_deleted: bool = False) -> list[dict]:
    q = select(Folder).where(Folder.user_id == user_id)
    if not include_deleted:
        q = q.where(Folder.deleted_at.is_(None))
    q = q.order_by(Folder.sort_order, Folder.name)
    rows = (await db.execute(q)).scalars().all()
    return [folder_dict(f) for f in rows]


async def get_folder(db: AsyncSession, user_id: str, folder_id: str) -> Folder:
    f = (
        await db.execute(
            select(Folder).where(
                Folder.id == folder_id,
                Folder.user_id == user_id,
                Folder.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not f:
        raise not_found("Folder not found")
    return f


async def _depth(db: AsyncSession, user_id: str, parent_id: str | None) -> int:
    depth = 0
    cur = parent_id
    seen: set[str] = set()
    while cur:
        if cur in seen:
            raise api_error("cycle", "Folder parent cycle detected")
        seen.add(cur)
        depth += 1
        if depth > MAX_DEPTH:
            raise api_error("depth_exceeded", f"Folder depth exceeds {MAX_DEPTH}")
        row = (
            await db.execute(
                select(Folder).where(Folder.id == cur, Folder.user_id == user_id)
            )
        ).scalar_one_or_none()
        if not row:
            break
        cur = row.parent_id
    return depth


async def create_folder(
    db: AsyncSession,
    user_id: str,
    name: str,
    parent_id: str | None = None,
    visibility: str = "private",
    sort_order: int | None = None,
) -> dict:
    if not name or not name.strip():
        raise api_error("validation", "name is required")
    if parent_id:
        await get_folder(db, user_id, parent_id)
        await _depth(db, user_id, parent_id)
    if sort_order is None:
        mx = (
            await db.execute(
                select(func.coalesce(func.max(Folder.sort_order), -1)).where(
                    Folder.user_id == user_id,
                    Folder.parent_id == parent_id if parent_id else Folder.parent_id.is_(None),
                    Folder.deleted_at.is_(None),
                )
            )
        ).scalar_one()
        sort_order = int(mx) + 1
    now = server_now()
    f = Folder(
        user_id=user_id,
        parent_id=parent_id,
        name=name.strip(),
        sort_order=sort_order,
        visibility=visibility if visibility in ("private", "unlisted", "public") else "private",
        is_system=False,
        created_at=now,
        updated_at=now,
    )
    db.add(f)
    await db.flush()
    await write_op(db, user_id, "folder", f.id, "create", folder_dict(f))
    return folder_dict(f)


async def update_folder(
    db: AsyncSession,
    user_id: str,
    folder_id: str,
    patch: dict[str, Any],
) -> dict:
    f = await get_folder(db, user_id, folder_id)
    # KD-35 system folder guards
    if f.is_system:
        if "parent_id" in patch and patch["parent_id"] != f.parent_id:
            raise api_error("system_folder", "Cannot change parent of system folder")
        if "visibility" in patch and patch["visibility"] != f.visibility:
            raise api_error("system_folder", "Cannot change visibility of system folder")
        if "is_system" in patch and patch["is_system"] is False:
            raise api_error("system_folder", "Cannot clear is_system")

    if "name" in patch and patch["name"] is not None:
        f.name = str(patch["name"]).strip() or f.name
    if "visibility" in patch and not f.is_system:
        v = patch["visibility"]
        if v in ("private", "unlisted", "public"):
            f.visibility = v
    if "parent_id" in patch and not f.is_system:
        new_parent = patch["parent_id"]
        if new_parent == f.id:
            raise api_error("validation", "Folder cannot be its own parent")
        if new_parent:
            await get_folder(db, user_id, new_parent)
            # prevent cycles: new parent must not be descendant
            await _assert_not_descendant(db, user_id, f.id, new_parent)
            await _depth(db, user_id, new_parent)
        f.parent_id = new_parent
    if "sort_order" in patch and patch["sort_order"] is not None:
        f.sort_order = int(patch["sort_order"])

    f.updated_at = server_now()
    await db.flush()
    await write_op(db, user_id, "folder", f.id, "update", folder_dict(f))
    return folder_dict(f)


async def _assert_not_descendant(
    db: AsyncSession, user_id: str, folder_id: str, candidate_parent: str
) -> None:
    cur = candidate_parent
    seen: set[str] = set()
    while cur:
        if cur == folder_id:
            raise api_error("cycle", "Cannot move folder under its descendant")
        if cur in seen:
            break
        seen.add(cur)
        row = (
            await db.execute(
                select(Folder).where(Folder.id == cur, Folder.user_id == user_id)
            )
        ).scalar_one_or_none()
        if not row:
            break
        cur = row.parent_id


async def delete_folder(
    db: AsyncSession,
    user_id: str,
    folder_id: str,
    mode: str = "move_to_parent",
) -> dict:
    mode_v = validate_folder_delete_mode(mode)
    f = await get_folder(db, user_id, folder_id)
    if f.is_system:
        raise api_error("system_folder", "Cannot delete system folder")

    now = server_now()
    children = (
        await db.execute(
            select(Folder).where(
                Folder.user_id == user_id,
                Folder.parent_id == folder_id,
                Folder.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    bookmarks = (
        await db.execute(
            select(Bookmark).where(
                Bookmark.user_id == user_id,
                Bookmark.folder_id == folder_id,
                Bookmark.deleted_at.is_(None),
            )
        )
    ).scalars().all()

    if mode_v == "cascade_soft_delete":
        await _cascade_soft_delete(db, user_id, folder_id, now)
    elif mode_v == "move_to_inbox":
        inbox_id = await get_inbox_folder_id(db, user_id)
        for c in children:
            c.parent_id = inbox_id
            c.updated_at = now
        for b in bookmarks:
            b.folder_id = inbox_id
            b.updated_at = now
    else:  # move_to_parent
        for c in children:
            c.parent_id = f.parent_id
            c.updated_at = now
        for b in bookmarks:
            if f.parent_id:
                b.folder_id = f.parent_id
            else:
                b.folder_id = await get_inbox_folder_id(db, user_id)
            b.updated_at = now

    f.deleted_at = now
    f.updated_at = now
    await db.flush()
    await write_op(
        db,
        user_id,
        "folder",
        f.id,
        "soft_delete",
        {**folder_dict(f), "delete_mode": mode_v},
    )
    return {"ok": True, "id": folder_id, "mode": mode_v}


async def _cascade_soft_delete(
    db: AsyncSession, user_id: str, folder_id: str, now
) -> None:
    stack = [folder_id]
    while stack:
        fid = stack.pop()
        kids = (
            await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id,
                    Folder.parent_id == fid,
                    Folder.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        for k in kids:
            if not k.is_system:
                stack.append(k.id)
                k.deleted_at = now
                k.updated_at = now
        bms = (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.user_id == user_id,
                    Bookmark.folder_id == fid,
                    Bookmark.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        for b in bms:
            b.deleted_at = now
            b.updated_at = now


async def reorder_folders(
    db: AsyncSession,
    user_id: str,
    parent_id: str | None,
    ordered_ids: list[str],
) -> dict:
    """Reorder sibling folders under parent_id. Enforces system/cycle/depth/sibling guards (F-008)."""
    if parent_id:
        await get_folder(db, user_id, parent_id)
        await _depth(db, user_id, parent_id)

    now = server_now()
    seen: set[str] = set()
    for i, fid in enumerate(ordered_ids):
        if fid in seen:
            raise api_error("validation", "Duplicate folder id in reorder list")
        seen.add(fid)
        f = await get_folder(db, user_id, fid)

        # KD-35: system folders cannot change parent
        if f.is_system:
            if parent_id is not None and parent_id != f.parent_id:
                raise api_error(
                    "system_folder",
                    "Cannot reparent system folder via reorder",
                )
            # Allow reordering only among siblings at same parent (typically root/null)
            if (f.parent_id or None) != (parent_id or None):
                raise api_error(
                    "system_folder",
                    "System folder must remain at its current parent",
                )
            f.sort_order = i
            f.updated_at = now
            continue

        # Sibling-scope: if already under parent, fine; if reparenting, validate
        current_parent = f.parent_id
        if (current_parent or None) != (parent_id or None):
            if parent_id:
                await _assert_not_descendant(db, user_id, f.id, parent_id)
                await _depth(db, user_id, parent_id)
            f.parent_id = parent_id

        f.sort_order = i
        f.updated_at = now

    # reorder_clocks
    clock = (
        await db.execute(
            select(ReorderClock).where(
                ReorderClock.user_id == user_id,
                ReorderClock.scope == "folder",
                ReorderClock.parent_id == (parent_id or ""),
            )
        )
    ).scalar_one_or_none()
    if clock is None:
        clock = ReorderClock(
            user_id=user_id,
            scope="folder",
            parent_id=parent_id or "",
            updated_at=now,
        )
        db.add(clock)
    else:
        clock.updated_at = now
    await db.flush()
    await write_op(
        db,
        user_id,
        "reorder",
        parent_id or "root",
        "reorder",
        {"scope": "folder", "parent_id": parent_id, "ordered_ids": ordered_ids},
    )
    return {"ok": True, "ordered_ids": ordered_ids}
