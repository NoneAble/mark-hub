from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import tags as svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(prefix="/tags", tags=["tags"])


class TagCreate(BaseModel):
    name: str
    color: str | None = None


class TagPatch(BaseModel):
    name: str | None = None
    color: str | None = None


@router.get("")
async def list_tags(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return {"items": await svc.list_tags(db, user.id)}


@router.post("")
async def create_tag(
    body: TagCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.create_tag(db, user.id, body.name, body.color)


@router.patch("/{tag_id}")
async def patch_tag(
    tag_id: str,
    body: TagPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.update_tag(db, user.id, tag_id, body.name, body.color)


@router.delete("/{tag_id}")
async def delete_tag(
    tag_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.delete_tag(db, user.id, tag_id)
