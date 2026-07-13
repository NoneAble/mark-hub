from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import nav as svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(prefix="/nav", tags=["nav"])


@router.get("/public")
async def public_nav(db: AsyncSession = Depends(get_db)):
    from app.config import get_settings
    from app.utils.errors import api_error

    if not get_settings().ff_public_nav:
        raise api_error("feature_disabled", "Public navigation is disabled", 503)
    # Single-admin: use first user
    result = await db.execute(select(User).limit(1))
    user = result.scalar_one_or_none()
    if not user:
        return {"tree": []}
    return await svc.public_nav_tree(db, user.id)


@router.get("/home")
async def home_nav(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.home_nav(db, user.id)
