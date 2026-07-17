from __future__ import annotations

from typing import Any

from app.models import Bookmark, Folder, Tag
from app.utils.timeutil import iso


def folder_dict(f: Folder) -> dict[str, Any]:
    return {
        "id": f.id,
        "user_id": f.user_id,
        "parent_id": f.parent_id,
        "name": f.name,
        "sort_order": f.sort_order,
        "visibility": f.visibility,
        "is_system": f.is_system,
        "deleted_at": iso(f.deleted_at),
        "created_at": iso(f.created_at),
        "updated_at": iso(f.updated_at),
    }


def bookmark_dict(b: Bookmark, tags: list[Tag] | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": b.id,
        "user_id": b.user_id,
        "folder_id": b.folder_id,
        "title": b.title,
        "url": b.url,
        "url_normalized": b.url_normalized,
        "description": b.description,
        "visibility": b.visibility,
        "is_favorite": b.is_favorite,
        "is_archived": b.is_archived,
        "sort_order": b.sort_order,
        "ai_summary": b.ai_summary,
        "ai_category": b.ai_category,
        "link_status": b.link_status,
        "deleted_at": iso(b.deleted_at),
        "created_at": iso(b.created_at),
        "updated_at": iso(b.updated_at),
    }
    if tags is not None:
        d["tags"] = [tag_dict(t) for t in tags]
    return d


def tag_dict(t: Tag) -> dict[str, Any]:
    return {
        "id": t.id,
        "user_id": t.user_id,
        "name": t.name,
        "color": t.color,
        "created_at": iso(t.created_at),
        "updated_at": iso(t.updated_at),
    }
