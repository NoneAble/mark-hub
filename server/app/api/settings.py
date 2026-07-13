from __future__ import annotations

import hashlib
import secrets
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.domain import ai_svc
from app.domain.settings_svc import (
    get_all_public_settings,
    get_setting,
    set_json_setting,
    set_setting,
)
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsBody(BaseModel):
    theme: str | None = None
    language: str | None = None
    site_title: str | None = None
    site_icon: str | None = None
    accent: str | None = None
    wallpaper: str | None = None
    card_density: str | None = None
    root_folder_id: str | None = None
    pinned_folder_ids: list[str] | None = None
    expanded_folder_ids: list[str] | None = None
    collection_board_name: str | None = None
    compare_engines: list[Any] | None = None
    compare_active_ids: list[Any] | None = None
    discover_widgets: list[Any] | None = None
    info_entries: list[Any] | None = None


@router.get("")
async def get_settings_api(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await get_all_public_settings(db, user.id)


@router.put("")
async def put_settings(
    body: SettingsBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = body.model_dump(exclude_none=True)
    for k, v in data.items():
        if isinstance(v, (list, dict)):
            await set_json_setting(db, user.id, k, v)
        else:
            await set_setting(db, user.id, k, str(v))
    return await get_all_public_settings(db, user.id)


@router.get("/ai")
async def get_ai(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await ai_svc.get_ai_config(db, user.id)


@router.put("/ai")
async def put_ai(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await ai_svc.save_ai_config(db, user.id, body)


@router.post("/ai/test")
async def test_ai(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await ai_svc.test_ai(db, user.id)


@router.get("/mcp")
async def get_mcp(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    settings = get_settings()
    token_hash = await get_setting(db, user.id, "mcp_token_hash", "")
    return {
        "enabled": (await get_setting(db, user.id, "mcp_enabled", "false")) == "true"
        or settings.mcp_enabled,
        "token_set": bool(token_hash),
        "allowed_origins": await get_setting(db, user.id, "mcp_allowed_origins", ""),
    }


@router.put("/mcp")
async def put_mcp(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if "enabled" in body:
        await set_setting(db, user.id, "mcp_enabled", "true" if body["enabled"] else "false")
    if "allowed_origins" in body:
        await set_setting(db, user.id, "mcp_allowed_origins", str(body["allowed_origins"]))
    if body.get("token"):
        th = hashlib.sha256(str(body["token"]).encode()).hexdigest()
        await set_setting(db, user.id, "mcp_token_hash", th, is_secret=True)
    return await get_mcp(user, db)


@router.post("/mcp/token")
async def rotate_mcp_token(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    token = secrets.token_urlsafe(32)
    th = hashlib.sha256(token.encode()).hexdigest()
    await set_setting(db, user.id, "mcp_token_hash", th, is_secret=True)
    await set_setting(db, user.id, "mcp_enabled", "true")
    return {"token": token, "token_set": True, "enabled": True}
