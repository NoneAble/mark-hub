from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.visibility import effective_visibility, is_public_nav_visible
from app.models import Bookmark, Folder


async def _ancestor_visibilities(
    folders_by_id: dict[str, Folder], folder_id: str | None
) -> list[str]:
    chain: list[str] = []
    cur = folder_id
    seen: set[str] = set()
    while cur and cur not in seen:
        seen.add(cur)
        f = folders_by_id.get(cur)
        if not f:
            break
        chain.append(f.visibility)
        cur = f.parent_id
    return chain


async def public_nav_tree(db: AsyncSession, user_id: str) -> dict:
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
    bookmarks = list(
        (
            await db.execute(
                select(Bookmark).where(
                    Bookmark.user_id == user_id,
                    Bookmark.deleted_at.is_(None),
                    Bookmark.is_archived == False,  # noqa: E712
                )
            )
        )
        .scalars()
        .all()
    )
    by_id = {f.id: f for f in folders}

    # Filter folders with effective public
    public_folder_ids: set[str] = set()
    for f in folders:
        ancestors = await _ancestor_visibilities(by_id, f.parent_id)
        if is_public_nav_visible(f.visibility, ancestors):
            public_folder_ids.add(f.id)

    children_map: dict[str | None, list] = {}
    for f in folders:
        if f.id not in public_folder_ids:
            continue
        # parent must also be public (or root)
        if f.parent_id and f.parent_id not in public_folder_ids:
            continue
        node = {
            "type": "folder",
            "id": f.id,
            "name": f.name,
            "visibility": effective_visibility(
                f.visibility, await _ancestor_visibilities(by_id, f.parent_id)
            ),
            "sort_order": f.sort_order,
            "children": [],
        }
        children_map.setdefault(f.parent_id, []).append(node)

    bm_by_folder: dict[str, list] = {}
    for b in bookmarks:
        ancestors = await _ancestor_visibilities(by_id, b.folder_id)
        if not is_public_nav_visible(b.visibility, ancestors):
            continue
        if b.folder_id not in public_folder_ids and b.folder_id is not None:
            # folder itself not public → hidden
            f = by_id.get(b.folder_id)
            if f is None:
                continue
            f_anc = await _ancestor_visibilities(by_id, f.parent_id)
            if not is_public_nav_visible(f.visibility, f_anc):
                continue
        bm_by_folder.setdefault(b.folder_id, []).append(
            {
                "type": "bookmark",
                "id": b.id,
                "title": b.title,
                "url": b.url,
                "description": b.description,
                "visibility": b.visibility,
                "sort_order": b.sort_order,
            }
        )

    def attach(nodes: list) -> list:
        for n in nodes:
            if n["type"] == "folder":
                kids = children_map.get(n["id"], [])
                kids_sorted = sorted(kids, key=lambda x: (x["sort_order"], x.get("name", "")))
                bms = sorted(
                    bm_by_folder.get(n["id"], []),
                    key=lambda x: (x["sort_order"], x.get("title", "")),
                )
                n["children"] = attach(kids_sorted) + bms
        return sorted(nodes, key=lambda x: (x["sort_order"], x.get("name", x.get("title", ""))))

    roots = attach(children_map.get(None, []))
    # bookmarks in root folders that are public but also orphan public bookmarks
    return {"tree": roots}


async def home_nav(db: AsyncSession, user_id: str) -> dict:
    """Authenticated home: all non-deleted folders + bookmarks (for edit mode)."""
    folders = list(
        (
            await db.execute(
                select(Folder)
                .where(Folder.user_id == user_id, Folder.deleted_at.is_(None))
                .order_by(Folder.sort_order)
            )
        )
        .scalars()
        .all()
    )
    bookmarks = list(
        (
            await db.execute(
                select(Bookmark)
                .where(Bookmark.user_id == user_id, Bookmark.deleted_at.is_(None))
                .order_by(Bookmark.sort_order)
            )
        )
        .scalars()
        .all()
    )
    return {
        "folders": [
            {
                "id": f.id,
                "parent_id": f.parent_id,
                "name": f.name,
                "visibility": f.visibility,
                "is_system": f.is_system,
                "sort_order": f.sort_order,
            }
            for f in folders
        ],
        "bookmarks": [
            {
                "id": b.id,
                "folder_id": b.folder_id,
                "title": b.title,
                "url": b.url,
                "description": b.description,
                "visibility": b.visibility,
                "is_favorite": b.is_favorite,
                "is_archived": b.is_archived,
                "sort_order": b.sort_order,
            }
            for b in bookmarks
        ],
    }
