from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.oplog import write_op
from app.domain.serializers import annotation_dict, board_dict, group_dict
from app.models import Annotation, Board, BoardGroup, Bookmark, Folder, OpLog
from app.utils.errors import api_error, not_found
from app.utils.timeutil import server_now


async def list_boards(db: AsyncSession, user_id: str) -> list[dict]:
    rows = (
        await db.execute(
            select(Board).where(Board.user_id == user_id).order_by(Board.created_at.desc())
        )
    ).scalars().all()
    return [board_dict(b) for b in rows]


async def get_board(db: AsyncSession, user_id: str, board_id: str) -> Board:
    b = (
        await db.execute(
            select(Board).where(Board.id == board_id, Board.user_id == user_id)
        )
    ).scalar_one_or_none()
    if not b:
        raise not_found("Board not found")
    return b


async def create_board(db: AsyncSession, user_id: str, data: dict[str, Any]) -> dict:
    name = (data.get("name") or "").strip()
    if not name:
        raise api_error("validation", "name is required")
    now = server_now()
    b = Board(
        user_id=user_id,
        name=name,
        type=data.get("type") or "ai_channels",
        source_folder_ids=json.dumps(data.get("source_folder_ids") or []),
        schema_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(b)
    await db.flush()
    await write_op(db, user_id, "board", b.id, "create", board_dict(b))
    return board_dict(b)


async def update_board(
    db: AsyncSession, user_id: str, board_id: str, patch: dict[str, Any]
) -> dict:
    b = await get_board(db, user_id, board_id)
    sources_changed = False
    if "name" in patch and patch["name"]:
        b.name = str(patch["name"]).strip()
    if "type" in patch and patch["type"]:
        b.type = patch["type"]
    if "source_folder_ids" in patch:
        b.source_folder_ids = json.dumps(patch["source_folder_ids"] or [])
        sources_changed = True
    b.updated_at = server_now()
    await db.flush()
    await write_op(db, user_id, "board", b.id, "update", board_dict(b))
    result = board_dict(b)
    # F020: changing Board sources triggers a full scan
    if sources_changed:
        try:
            await scan_board(db, user_id, board_id, mode="full")
        except Exception:
            pass
    return result


async def delete_board(db: AsyncSession, user_id: str, board_id: str) -> dict:
    b = await get_board(db, user_id, board_id)
    anns = (
        await db.execute(select(Annotation).where(Annotation.board_id == board_id))
    ).scalars().all()
    for a in anns:
        await db.delete(a)
    groups = (
        await db.execute(select(BoardGroup).where(BoardGroup.board_id == board_id))
    ).scalars().all()
    for g in groups:
        await db.delete(g)
    await db.delete(b)
    await db.flush()
    await write_op(db, user_id, "board", board_id, "delete", {"id": board_id})
    return {"ok": True, "id": board_id}


def _collect_subtree(root_ids: list[str], folders: list[Folder]) -> set[str]:
    children: dict[str | None, list[str]] = {}
    for f in folders:
        if f.deleted_at:
            continue
        children.setdefault(f.parent_id, []).append(f.id)
    out: set[str] = set()
    stack = list(root_ids)
    while stack:
        i = stack.pop()
        if i in out:
            continue
        out.add(i)
        stack.extend(children.get(i, []))
    return out


async def _folder_path(db: AsyncSession, user_id: str, folder_id: str, cache: dict) -> str:
    if folder_id in cache:
        return cache[folder_id]
    parts: list[str] = []
    cur = folder_id
    seen: set[str] = set()
    while cur and cur not in seen:
        seen.add(cur)
        f = (
            await db.execute(
                select(Folder).where(Folder.id == cur, Folder.user_id == user_id)
            )
        ).scalar_one_or_none()
        if not f:
            break
        parts.append(f.name)
        cur = f.parent_id
    path = "/".join(reversed(parts))
    cache[folder_id] = path
    return path


async def scan_board(
    db: AsyncSession,
    user_id: str,
    board_id: str,
    mode: str = "full",
) -> dict:
    board = await get_board(db, user_id, board_id)
    try:
        source_ids = json.loads(board.source_folder_ids or "[]")
    except json.JSONDecodeError:
        source_ids = []

    # auto full fallback for incremental
    if mode == "incremental":
        max_op = (
            await db.execute(
                select(OpLog.id)
                .where(OpLog.user_id == user_id)
                .order_by(OpLog.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none() or 0
        watermark = board.last_incremental_cursor
        if watermark is None or (max_op - watermark) > 50_000:
            mode = "full"
        else:
            return await _incremental_scan(db, user_id, board, watermark, max_op, source_ids)

    return await _full_scan(db, user_id, board, source_ids)


async def _full_scan(
    db: AsyncSession, user_id: str, board: Board, source_ids: list[str]
) -> dict:
    folders = list(
        (
            await db.execute(
                select(Folder).where(Folder.user_id == user_id, Folder.deleted_at.is_(None))
            )
        )
        .scalars()
        .all()
    )
    subtree = _collect_subtree(source_ids, folders) if source_ids else {f.id for f in folders}
    bms = list(
        (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.user_id == user_id,
                    Bookmark.deleted_at.is_(None),
                    Bookmark.folder_id.in_(list(subtree)) if subtree else True,
                )
            )
        )
        .scalars()
        .all()
    )
    existing = list(
        (
            await db.execute(select(Annotation).where(Annotation.board_id == board.id))
        )
        .scalars()
        .all()
    )
    by_bm = {a.bookmark_id: a for a in existing}
    path_cache: dict[str, str] = {}
    now = server_now()
    seen: set[str] = set()
    created = updated = 0

    groups = list(
        (
            await db.execute(select(BoardGroup).where(BoardGroup.board_id == board.id))
        )
        .scalars()
        .all()
    )

    for b in bms:
        path = await _folder_path(db, user_id, b.folder_id, path_cache)
        ann = by_bm.get(b.id)
        if ann:
            ann.present = True
            ann.last_seen_at = now
            ann.missing_since = None
            ann.source_folder_id = b.folder_id
            ann.source_folder_path = path
            ann.annotation_updated_at = now
            # keyword group assignment if ungrouped
            if not ann.group_id:
                ann.group_id = _guess_group(groups, b.title, b.url)
            updated += 1
            seen.add(ann.id)
        else:
            gid = _guess_group(groups, b.title, b.url)
            ann = Annotation(
                board_id=board.id,
                bookmark_id=b.id,
                status="pending",
                risk="",
                price_tag="",
                category=None,
                group_id=gid,
                secondary_group_ids="[]",
                note=None,
                source_folder_id=b.folder_id,
                source_folder_path=path,
                present=True,
                first_seen_at=now,
                last_seen_at=now,
                annotation_updated_at=now,
                fields="{}",
            )
            db.add(ann)
            await db.flush()
            created += 1
            seen.add(ann.id)

    missing = 0
    for a in existing:
        if a.id not in seen and a.present:
            a.present = False
            a.missing_since = now
            a.annotation_updated_at = now
            missing += 1

    max_op = (
        await db.execute(
            select(OpLog.id)
            .where(OpLog.user_id == user_id)
            .order_by(OpLog.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    board.last_full_scan_at = now
    board.last_incremental_cursor = max_op
    board.updated_at = now
    await db.flush()
    # F006: emit annotation ops for audit /changes consumers
    for a in existing:
        if a.id in seen:
            await write_op(
                db,
                user_id,
                "annotation",
                a.id,
                "update",
                {"from": "scan_full", "present": a.present, "bookmark_id": a.bookmark_id},
            )
    # Newly created annotations (not in original existing map)
    fresh = list(
        (
            await db.execute(select(Annotation).where(Annotation.board_id == board.id))
        )
        .scalars()
        .all()
    )
    existing_ids = {a.id for a in existing}
    for a in fresh:
        if a.id not in existing_ids:
            await write_op(
                db,
                user_id,
                "annotation",
                a.id,
                "create",
                {"from": "scan_full", "bookmark_id": a.bookmark_id},
            )
    await write_op(
        db,
        user_id,
        "board",
        board.id,
        "update",
        {"scan": "full", "created": created, "updated": updated, "missing": missing},
    )
    return {
        "mode": "full",
        "created": created,
        "updated": updated,
        "missing": missing,
        "cursor": max_op,
    }


async def _incremental_scan(
    db: AsyncSession,
    user_id: str,
    board: Board,
    watermark: int,
    max_op: int,
    source_ids: list[str],
) -> dict:
    changes = list(
        (
            await db.execute(
                select(OpLog).where(
                    OpLog.user_id == user_id,
                    OpLog.id > watermark,
                    OpLog.entity_type.in_(["bookmark", "folder", "reorder"]),
                )
            )
        )
        .scalars()
        .all()
    )
    folders = list(
        (
            await db.execute(
                select(Folder).where(Folder.user_id == user_id, Folder.deleted_at.is_(None))
            )
        )
        .scalars()
        .all()
    )
    subtree = _collect_subtree(source_ids, folders) if source_ids else {f.id for f in folders}
    now = server_now()
    applied = 0
    path_cache: dict[str, str] = {}

    for ch in changes:
        if ch.entity_type == "bookmark":
            b = (
                await db.execute(
                    select(Bookmark).where(
                        Bookmark.id == ch.entity_id, Bookmark.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
            ann = (
                await db.execute(
                    select(Annotation).where(
                        Annotation.board_id == board.id,
                        Annotation.bookmark_id == ch.entity_id,
                    )
                )
            ).scalar_one_or_none()
            if b is None or b.deleted_at is not None or b.folder_id not in subtree:
                if ann and ann.present:
                    ann.present = False
                    ann.missing_since = now
                    ann.annotation_updated_at = now
                    applied += 1
                continue
            path = await _folder_path(db, user_id, b.folder_id, path_cache)
            if ann:
                ann.present = True
                ann.last_seen_at = now
                ann.missing_since = None
                ann.source_folder_id = b.folder_id
                ann.source_folder_path = path
                ann.annotation_updated_at = now
            else:
                db.add(
                    Annotation(
                        board_id=board.id,
                        bookmark_id=b.id,
                        status="pending",
                        source_folder_id=b.folder_id,
                        source_folder_path=path,
                        present=True,
                        first_seen_at=now,
                        last_seen_at=now,
                        annotation_updated_at=now,
                        fields="{}",
                        secondary_group_ids="[]",
                    )
                )
            applied += 1
        elif ch.entity_type in ("folder", "reorder"):
            # Folder move/delete/reorder can change membership — re-eval all annotations (F-006)
            applied += await _reeval_membership(
                db, user_id, board, subtree, now, path_cache
            )

    new_cursor = max((c.id for c in changes), default=watermark)
    board.last_incremental_cursor = new_cursor
    board.updated_at = now
    await db.flush()
    # F006: board-level scan op for incremental (annotation writes already emit via create/update paths when present)
    await write_op(
        db,
        user_id,
        "board",
        board.id,
        "update",
        {"scan": "incremental", "applied": applied, "changes": len(changes)},
    )
    return {
        "mode": "incremental",
        "applied": applied,
        "changes": len(changes),
        "cursor": new_cursor,
    }


async def _reeval_membership(
    db: AsyncSession,
    user_id: str,
    board: Board,
    subtree: set[str],
    now,
    path_cache: dict[str, str],
) -> int:
    """Re-check every annotation and source-subtree bookmark after folder/reorder ops."""
    applied = 0
    anns = list(
        (
            await db.execute(select(Annotation).where(Annotation.board_id == board.id))
        )
        .scalars()
        .all()
    )
    by_bm = {a.bookmark_id: a for a in anns}
    # Mark missing if bookmark left subtree
    for a in anns:
        b = (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.id == a.bookmark_id, Bookmark.user_id == user_id
                )
            )
        ).scalar_one_or_none()
        in_tree = (
            b is not None
            and b.deleted_at is None
            and b.folder_id in subtree
        )
        if not in_tree:
            if a.present:
                a.present = False
                a.missing_since = now
                a.annotation_updated_at = now
                applied += 1
        else:
            path = await _folder_path(db, user_id, b.folder_id, path_cache)
            if not a.present or a.source_folder_id != b.folder_id:
                a.present = True
                a.missing_since = None
                a.last_seen_at = now
                a.source_folder_id = b.folder_id
                a.source_folder_path = path
                a.annotation_updated_at = now
                applied += 1
    # Upsert any live bookmarks now in subtree without annotation
    bms = list(
        (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.user_id == user_id,
                    Bookmark.deleted_at.is_(None),
                    Bookmark.folder_id.in_(list(subtree)) if subtree else True,
                )
            )
        )
        .scalars()
        .all()
    )
    for b in bms:
        if b.id in by_bm:
            continue
        path = await _folder_path(db, user_id, b.folder_id, path_cache)
        db.add(
            Annotation(
                board_id=board.id,
                bookmark_id=b.id,
                status="pending",
                source_folder_id=b.folder_id,
                source_folder_path=path,
                present=True,
                first_seen_at=now,
                last_seen_at=now,
                annotation_updated_at=now,
                fields="{}",
                secondary_group_ids="[]",
            )
        )
        applied += 1
    return applied



def _guess_group(groups: list[BoardGroup], title: str, url: str) -> str | None:
    text = f"{title} {url}".lower()
    for g in groups:
        try:
            kws = json.loads(g.keywords or "[]")
        except json.JSONDecodeError:
            kws = []
        for kw in kws:
            if kw and str(kw).lower() in text:
                return g.id
    return None


async def list_annotations(db: AsyncSession, user_id: str, board_id: str) -> list[dict]:
    await get_board(db, user_id, board_id)
    rows = (
        await db.execute(
            select(Annotation)
            .where(Annotation.board_id == board_id)
            .order_by(Annotation.last_seen_at.desc())
        )
    ).scalars().all()
    return [annotation_dict(a) for a in rows]


async def update_annotation(
    db: AsyncSession, user_id: str, board_id: str, aid: str, patch: dict
) -> dict:
    await get_board(db, user_id, board_id)
    a = (
        await db.execute(
            select(Annotation).where(Annotation.id == aid, Annotation.board_id == board_id)
        )
    ).scalar_one_or_none()
    if not a:
        raise not_found("Annotation not found")
    for field in ("status", "risk", "price_tag", "category", "note", "group_id"):
        if field in patch:
            setattr(a, field, patch[field])
    if "secondary_group_ids" in patch:
        a.secondary_group_ids = json.dumps(patch["secondary_group_ids"] or [])
    if "fields" in patch and isinstance(patch["fields"], dict):
        a.fields = json.dumps(patch["fields"])
    a.annotation_updated_at = server_now()
    await db.flush()
    await write_op(db, user_id, "annotation", a.id, "update", annotation_dict(a))
    return annotation_dict(a)


async def batch_annotations(
    db: AsyncSession, user_id: str, board_id: str, items: list[dict], atomic: bool = True
) -> dict:
    if len(items) > 500:
        raise api_error("validation", "max 500 items")
    results = []
    try:
        for it in items:
            results.append(
                await update_annotation(
                    db, user_id, board_id, it["annotation_id"], it.get("patch") or {}
                )
            )
    except Exception:
        if atomic:
            raise
    return {"ok": True, "count": len(results), "items": results}


async def list_groups(db: AsyncSession, user_id: str, board_id: str) -> list[dict]:
    await get_board(db, user_id, board_id)
    rows = (
        await db.execute(
            select(BoardGroup)
            .where(BoardGroup.board_id == board_id)
            .order_by(BoardGroup.sort_order)
        )
    ).scalars().all()
    return [group_dict(g) for g in rows]


async def create_group(db: AsyncSession, user_id: str, board_id: str, data: dict) -> dict:
    await get_board(db, user_id, board_id)
    g = BoardGroup(
        board_id=board_id,
        name=(data.get("name") or "Group").strip(),
        color=data.get("color"),
        keywords=json.dumps(data.get("keywords") or []),
        sort_order=int(data.get("sort_order") or 0),
        collapsed=bool(data.get("collapsed", False)),
    )
    db.add(g)
    await db.flush()
    await write_op(db, user_id, "board_group", g.id, "create", group_dict(g))
    return group_dict(g)


async def reorder_groups(
    db: AsyncSession, user_id: str, board_id: str, ordered_ids: list[str]
) -> dict:
    await get_board(db, user_id, board_id)
    for i, gid in enumerate(ordered_ids):
        g = (
            await db.execute(
                select(BoardGroup).where(BoardGroup.id == gid, BoardGroup.board_id == board_id)
            )
        ).scalar_one_or_none()
        if g:
            g.sort_order = i
    await db.flush()
    await write_op(
        db,
        user_id,
        "reorder",
        board_id,
        "reorder",
        {"scope": "board_group", "ordered_ids": ordered_ids},
    )
    return {"ok": True, "ordered_ids": ordered_ids}


async def export_board(db: AsyncSession, user_id: str, board_id: str, fmt: str = "json") -> Any:
    from html import escape

    board = board_dict(await get_board(db, user_id, board_id))
    anns = await list_annotations(db, user_id, board_id)
    groups = await list_groups(db, user_id, board_id)
    if fmt == "html":
        title = escape(str(board.get("name") or "Board"))
        lines = [
            "<!DOCTYPE html><html><head><meta charset=utf-8><title>"
            + title
            + "</title></head><body>",
            f"<h1>{title}</h1><ul>",
        ]
        for a in anns:
            status = escape(str(a.get("status") or ""))
            bid = escape(str(a.get("bookmark_id") or ""))
            path = escape(str(a.get("source_folder_path") or ""))
            note = escape(str(a.get("note") or ""))
            lines.append(
                f'<li data-status="{status}">bookmark={bid} {path} {note}</li>'
            )
        lines.append("</ul></body></html>")
        return "\n".join(lines)
    return {"board": board, "groups": groups, "annotations": anns}


async def import_board(
    db: AsyncSession,
    user_id: str,
    board_id: str,
    data: dict[str, Any],
    *,
    merge: bool = True,
) -> dict:
    """Import board groups/annotations (Smart-Bookmark ai-channels compatible) — F-021."""
    board = await get_board(db, user_id, board_id)
    payload = data
    # Accept wrapped export or SB-style channel pack
    if "board" in data and isinstance(data["board"], dict):
        payload = data
    elif "channels" in data or "items" in data:
        # Smart-Bookmark style: map channels → groups, items → annotations
        payload = {
            "groups": data.get("channels") or data.get("groups") or [],
            "annotations": data.get("items") or data.get("annotations") or [],
        }

    groups_in = payload.get("groups") or []
    anns_in = payload.get("annotations") or []
    name_to_id: dict[str, str] = {}
    created_g = created_a = updated_a = 0

    # Existing groups by name
    existing_groups = await list_groups(db, user_id, board_id)
    for g in existing_groups:
        name_to_id[g["name"]] = g["id"]

    for g in groups_in:
        if not isinstance(g, dict):
            continue
        name = (g.get("name") or g.get("title") or "Group").strip()
        if name in name_to_id and merge:
            continue
        created = await create_group(
            db,
            user_id,
            board_id,
            {
                "name": name,
                "color": g.get("color"),
                "keywords": g.get("keywords") or g.get("tags") or [],
                "sort_order": g.get("sort_order", 0),
            },
        )
        name_to_id[name] = created["id"]
        created_g += 1

    # Map status from SB inventory-ish names to neutral KD-40
    status_map = {
        "in_stock": "active",
        "available": "active",
        "out_of_stock": "dead",
        "discontinued": "dead",
        "有货": "active",
        "下架": "dead",
    }

    unmatched = 0
    for a in anns_in:
        if not isinstance(a, dict):
            continue
        bookmark_id = a.get("bookmark_id") or a.get("id")
        bm = None
        if bookmark_id:
            bm = (
                await db.execute(
                    select(Bookmark).where(
                        Bookmark.id == bookmark_id,
                        Bookmark.user_id == user_id,
                        Bookmark.deleted_at.is_(None),
                    )
                )
            ).scalar_one_or_none()
        # F-004: resolve URL-only records via normalizeUrl + deterministic oldest-live match
        if bm is None:
            raw_url = a.get("url") or a.get("href") or a.get("link")
            if raw_url:
                from app.utils.normalize import normalize_url

                norm = normalize_url(str(raw_url))
                if norm:
                    candidates = list(
                        (
                            await db.execute(
                                select(Bookmark)
                                .where(
                                    Bookmark.user_id == user_id,
                                    Bookmark.url_normalized == norm,
                                    Bookmark.deleted_at.is_(None),
                                )
                                .order_by(Bookmark.created_at.asc())
                            )
                        )
                        .scalars()
                        .all()
                    )
                    if candidates:
                        bm = candidates[0]
        if bm is None:
            unmatched += 1
            continue

        status = a.get("status") or "pending"
        status = status_map.get(str(status), status)
        if status not in ("active", "limited", "pending", "watching", "dead", "blocked"):
            status = "pending"

        group_id = a.get("group_id")
        if not group_id and a.get("group"):
            group_id = name_to_id.get(str(a["group"]))
        if not group_id and a.get("channel"):
            group_id = name_to_id.get(str(a["channel"]))

        existing = (
            await db.execute(
                select(Annotation).where(
                    Annotation.board_id == board_id,
                    Annotation.bookmark_id == bm.id,
                )
            )
        ).scalar_one_or_none()
        patch = {
            "status": status,
            "risk": a.get("risk") or "",
            "price_tag": a.get("price_tag") or a.get("price") or "",
            "category": a.get("category"),
            "group_id": group_id,
            "note": a.get("note") or a.get("remark"),
            "fields": a.get("fields") if isinstance(a.get("fields"), dict) else {},
        }
        if existing:
            await update_annotation(db, user_id, board_id, existing.id, patch)
            updated_a += 1
        else:
            now = server_now()
            ann = Annotation(
                board_id=board_id,
                bookmark_id=bm.id,
                status=status,
                risk=patch["risk"] or "",
                price_tag=patch["price_tag"] or "",
                category=patch.get("category"),
                group_id=group_id,
                secondary_group_ids=json.dumps(a.get("secondary_group_ids") or []),
                note=patch.get("note"),
                source_folder_id=bm.folder_id,
                source_folder_path=a.get("source_folder_path") or "",
                present=True,
                first_seen_at=now,
                last_seen_at=now,
                annotation_updated_at=now,
                fields=json.dumps(patch.get("fields") or {}),
            )
            db.add(ann)
            await db.flush()
            await write_op(db, user_id, "annotation", ann.id, "create", annotation_dict(ann))
            created_a += 1

    board.updated_at = server_now()
    await db.flush()
    return {
        "ok": True,
        "board_id": board_id,
        "groups_created": created_g,
        "annotations_created": created_a,
        "annotations_updated": updated_a,
        "unmatched": unmatched,
    }

