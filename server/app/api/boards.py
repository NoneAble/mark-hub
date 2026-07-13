from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import boards as svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(prefix="/boards", tags=["boards"])


def _require_boards():
    from app.config import get_settings
    from app.utils.errors import api_error

    if not get_settings().ff_boards:
        raise api_error("feature_disabled", "Boards are disabled", 503)


class BoardCreate(BaseModel):
    name: str
    type: str = "ai_channels"
    source_folder_ids: list[str] = []


class BoardPatch(BaseModel):
    name: str | None = None
    type: str | None = None
    source_folder_ids: list[str] | None = None


class ScanBody(BaseModel):
    mode: str = "full"


class AnnPatch(BaseModel):
    status: str | None = None
    risk: str | None = None
    price_tag: str | None = None
    category: str | None = None
    group_id: str | None = None
    secondary_group_ids: list[str] | None = None
    note: str | None = None
    fields: dict[str, Any] | None = None


class AnnBatch(BaseModel):
    atomic: bool = True
    items: list[dict]


class GroupCreate(BaseModel):
    name: str
    color: str | None = None
    keywords: list[str] = []
    sort_order: int = 0


class ReorderBody(BaseModel):
    ordered_ids: list[str]


class ExportBody(BaseModel):
    format: str = "json"


@router.get("")
async def list_boards(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    _require_boards()
    return {"items": await svc.list_boards(db, user.id)}


@router.post("")
async def create_board(
    body: BoardCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.create_board(db, user.id, body.model_dump())


@router.get("/{board_id}")
async def get_board(
    board_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    from app.domain.serializers import board_dict

    return board_dict(await svc.get_board(db, user.id, board_id))


@router.patch("/{board_id}")
async def patch_board(
    board_id: str,
    body: BoardPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.update_board(
        db, user.id, board_id, body.model_dump(exclude_none=True)
    )


@router.delete("/{board_id}")
async def delete_board(
    board_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.delete_board(db, user.id, board_id)


@router.post("/{board_id}/scan")
async def scan(
    board_id: str,
    body: ScanBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.scan_board(db, user.id, board_id, mode=body.mode)


@router.get("/{board_id}/annotations")
async def annotations(
    board_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return {"items": await svc.list_annotations(db, user.id, board_id)}


@router.patch("/{board_id}/annotations/{aid}")
async def patch_ann(
    board_id: str,
    aid: str,
    body: AnnPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.update_annotation(
        db, user.id, board_id, aid, body.model_dump(exclude_none=True)
    )


@router.post("/{board_id}/annotations/batch")
async def batch_ann(
    board_id: str,
    body: AnnBatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.batch_annotations(
        db, user.id, board_id, body.items, atomic=body.atomic
    )


@router.get("/{board_id}/groups")
async def groups(
    board_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return {"items": await svc.list_groups(db, user.id, board_id)}


@router.post("/{board_id}/groups")
async def create_group(
    board_id: str,
    body: GroupCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.create_group(db, user.id, board_id, body.model_dump())


@router.post("/{board_id}/groups/reorder")
async def reorder_groups(
    board_id: str,
    body: ReorderBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.reorder_groups(db, user.id, board_id, body.ordered_ids)


@router.post("/{board_id}/export")
async def export_board(
    board_id: str,
    body: ExportBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    data = await svc.export_board(db, user.id, board_id, fmt=body.format)
    if body.format == "html":
        return Response(content=data, media_type="text/html")
    return data


class ImportBody(BaseModel):
    data: dict[str, Any]
    merge: bool = True


@router.post("/{board_id}/import")
async def import_board(
    board_id: str,
    body: ImportBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_boards()
    return await svc.import_board(db, user.id, board_id, body.data, merge=body.merge)

