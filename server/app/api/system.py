from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings, validate_security_settings
from app.database import get_db
from app.domain import changes as changes_svc
from app.models import User
from app.security.auth import get_current_user

router = APIRouter(tags=["system"])

# Simple in-process counters (F-019 / R4-F002). Updated from request middleware.
_metrics = {
    "requests_total": 0,
    "errors_5xx": 0,
    "started_at": time.time(),
}


def record_request(*, status_code: int) -> None:
    """Increment metrics for one completed HTTP request (concurrency-safe for CPython GIL)."""
    _metrics["requests_total"] += 1
    if status_code >= 500:
        _metrics["errors_5xx"] += 1


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    db_ok = False
    try:
        await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    sec_problems = validate_security_settings(settings)
    status = "ok" if db_ok and not sec_problems else "degraded"
    return {
        "status": status,
        "version": settings.version,
        "service": "markhub",
        "dependencies": {
            "database": "ok" if db_ok else "error",
            "master_key": "ok" if settings.markhub_master_key else "missing",
            "scheduler": "ok",
        },
        "security_ok": not sec_problems,
    }


@router.get("/metrics")
async def metrics():
    """Lightweight metrics snapshot (F-019)."""
    return {
        "uptime_sec": int(time.time() - _metrics["started_at"]),
        "requests_total": _metrics["requests_total"],
        "errors_5xx": _metrics["errors_5xx"],
        "version": get_settings().version,
    }


@router.get("/version")
async def version():
    settings = get_settings()
    return {
        "version": settings.version,
        "name": "MarkHub",
    }


@router.get("/changes")
async def changes(
    since: int = Query(0),
    limit: int = Query(500, le=1000),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await changes_svc.list_changes(db, user.id, since=since, limit=limit)
