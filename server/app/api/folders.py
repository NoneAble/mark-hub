from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import folders as svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(prefix="/folders", tags=["folders"])

FolderDeleteModeQuery = Literal["move_to_parent", "move_to_inbox", "cascade_soft_delete"]


class FolderCreate(BaseModel):
    name: str
    parent_id: str | None = None
    visibility: str = "private"
    sort_order: int | None = None


class FolderPatch(BaseModel):
    name: str | None = None
    parent_id: str | None = None
    visibility: str | None = None
    sort_order: int | None = None


class ReorderBody(BaseModel):
    parent_id: str | None = None
    ordered_ids: list[str]


@router.get("")
async def list_folders(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return {"items": await svc.list_folders(db, user.id)}


@router.post("")
async def create_folder(
    body: FolderCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.create_folder(
        db,
        user.id,
        body.name,
        parent_id=body.parent_id,
        visibility=body.visibility,
        sort_order=body.sort_order,
    )


@router.patch("/{folder_id}")
async def patch_folder(
    folder_id: str,
    body: FolderPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.update_folder(
        db, user.id, folder_id, body.model_dump(exclude_unset=True)
    )


@router.delete("/{folder_id}")
async def delete_folder(
    folder_id: str,
    mode: FolderDeleteModeQuery = Query("move_to_parent"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.delete_folder(db, user.id, folder_id, mode=mode)


@router.post("/reorder")
async def reorder(
    body: ReorderBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.reorder_folders(db, user.id, body.parent_id, body.ordered_ids)
