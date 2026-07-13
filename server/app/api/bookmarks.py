from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import bookmarks as svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(prefix="/bookmarks", tags=["bookmarks"])


class BookmarkCreate(BaseModel):
    title: str | None = None
    url: str
    folder_id: str | None = None
    description: str | None = None
    visibility: str | None = "private"
    is_favorite: bool = False
    is_archived: bool = False
    tags: list[str] | None = None
    sort_order: int | None = None


class BookmarkPatch(BaseModel):
    title: str | None = None
    url: str | None = None
    folder_id: str | None = None
    description: str | None = None
    visibility: str | None = None
    is_favorite: bool | None = None
    is_archived: bool | None = None
    tags: list[str] | None = None
    sort_order: int | None = None
    link_status: str | None = None


class ReorderBody(BaseModel):
    folder_id: str
    ordered_ids: list[str]


class BatchBody(BaseModel):
    action: str
    ids: list[str]
    payload: dict[str, Any] | None = None
    # Legacy/top-level aliases (merged into payload) — R4-F014
    folder_id: str | None = None
    visibility: str | None = None
    is_archived: bool | None = None
    tags: list[str] | None = None

    def resolved_payload(self) -> dict[str, Any]:
        p = dict(self.payload or {})
        if self.folder_id is not None and "folder_id" not in p:
            p["folder_id"] = self.folder_id
        if self.visibility is not None and "visibility" not in p:
            p["visibility"] = self.visibility
        if self.is_archived is not None and "is_archived" not in p:
            p["is_archived"] = self.is_archived
        if self.tags is not None and "tags" not in p:
            p["tags"] = self.tags
        return p


@router.get("")
async def list_bookmarks(
    folder_id: str | None = None,
    q: str | None = None,
    include_archived: bool = True,
    visibility: str | None = None,
    limit: int = Query(500, le=1000),
    offset: int = 0,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.list_bookmarks(
        db,
        user.id,
        folder_id=folder_id,
        q=q,
        include_archived=include_archived,
        visibility=visibility,
        limit=limit,
        offset=offset,
    )


@router.post("")
async def create_bookmark(
    body: BookmarkCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.create_bookmark(db, user.id, body.model_dump(exclude_none=True))


@router.get("/{bookmark_id}")
async def get_bookmark(
    bookmark_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    b = await svc.get_bookmark(db, user.id, bookmark_id)
    from app.domain.bookmarks import _tags_for
    from app.domain.serializers import bookmark_dict

    tags = await _tags_for(db, b.id)
    return bookmark_dict(b, tags)


@router.patch("/{bookmark_id}")
async def patch_bookmark(
    bookmark_id: str,
    body: BookmarkPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.update_bookmark(
        db, user.id, bookmark_id, body.model_dump(exclude_none=True)
    )


@router.delete("/{bookmark_id}")
async def delete_bookmark(
    bookmark_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.delete_bookmark(db, user.id, bookmark_id)


@router.post("/reorder")
async def reorder(
    body: ReorderBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.reorder_bookmarks(db, user.id, body.folder_id, body.ordered_ids)


@router.post("/batch")
async def batch(
    body: BatchBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.batch_bookmarks(
        db, user.id, body.action, body.ids, body.resolved_payload()
    )
