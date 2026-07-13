from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import cleaner as svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(tags=["clean"])


class CleanJobBody(BaseModel):
    check_invalid: bool = False
    concurrency: int = 8


class ApplyBody(BaseModel):
    issue_ids: list[str]
    mark_link_status: bool = False


@router.post("/clean/jobs")
async def create_job(
    body: CleanJobBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.config import get_settings
    from app.utils.errors import api_error

    if body.check_invalid and not get_settings().ff_cleaner_network:
        raise api_error("feature_disabled", "Network cleaner is disabled", 503)
    return await svc.create_clean_job(
        db, user.id, check_invalid=body.check_invalid, concurrency=body.concurrency
    )


@router.get("/clean/jobs/{job_id}")
async def get_job(
    job_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.get_clean_job(db, user.id, job_id)


@router.post("/clean/apply")
async def apply(
    body: ApplyBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.apply_clean(
        db, user.id, body.issue_ids, mark_link_status=body.mark_link_status
    )


@router.get("/analytics/profile")
async def profile(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.analytics_profile(db, user.id)
