from __future__ import annotations

import json
from typing import Any

from app.models import Annotation, Board, BoardGroup, Bookmark, Folder, Tag
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


def board_dict(b: Board) -> dict[str, Any]:
    try:
        source = json.loads(b.source_folder_ids or "[]")
    except json.JSONDecodeError:
        source = []
    return {
        "id": b.id,
        "user_id": b.user_id,
        "name": b.name,
        "type": b.type,
        "source_folder_ids": source,
        "schema_version": b.schema_version,
        "last_full_scan_at": iso(b.last_full_scan_at),
        "last_incremental_cursor": b.last_incremental_cursor,
        "created_at": iso(b.created_at),
        "updated_at": iso(b.updated_at),
    }


def group_dict(g: BoardGroup) -> dict[str, Any]:
    try:
        keywords = json.loads(g.keywords or "[]")
    except json.JSONDecodeError:
        keywords = []
    return {
        "id": g.id,
        "board_id": g.board_id,
        "name": g.name,
        "color": g.color,
        "keywords": keywords,
        "sort_order": g.sort_order,
        "collapsed": g.collapsed,
    }


def annotation_dict(a: Annotation) -> dict[str, Any]:
    try:
        secondary = json.loads(a.secondary_group_ids or "[]")
    except json.JSONDecodeError:
        secondary = []
    try:
        fields = json.loads(a.fields or "{}")
    except json.JSONDecodeError:
        fields = {}
    return {
        "id": a.id,
        "board_id": a.board_id,
        "bookmark_id": a.bookmark_id,
        "status": a.status,
        "risk": a.risk,
        "price_tag": a.price_tag,
        "category": a.category,
        "group_id": a.group_id,
        "secondary_group_ids": secondary,
        "note": a.note,
        "source_ref": a.source_ref,
        "source_folder_id": a.source_folder_id,
        "source_folder_path": a.source_folder_path,
        "present": a.present,
        "first_seen_at": iso(a.first_seen_at),
        "last_seen_at": iso(a.last_seen_at),
        "missing_since": iso(a.missing_since),
        "annotation_updated_at": iso(a.annotation_updated_at),
        "fields": fields,
    }
