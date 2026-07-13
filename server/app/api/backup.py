from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import backup as backup_svc
from app.domain import remote_backup as remote
from app.models import User
from app.security.auth import get_current_user
from app.utils.errors import api_error

router = APIRouter(prefix="/backup", tags=["backup"])

BackupFormat = Literal["json", "csv", "html"]
BackupStrategy = Literal["skip_duplicate", "merge", "replace_all"]


class ImportBody(BaseModel):
    content: str
    format: BackupFormat = "json"
    strategy: BackupStrategy = "skip_duplicate"
    confirm_replace: bool = False


@router.get("/export")
async def export(
    format: BackupFormat = Query("json"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if format == "csv":
        text = await backup_svc.export_csv(db, user.id)
        return Response(
            content=text,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=markhub.csv"},
        )
    if format == "html":
        text = await backup_svc.export_html(db, user.id)
        return Response(
            content=text,
            media_type="text/html",
            headers={"Content-Disposition": "attachment; filename=markhub.html"},
        )
    data = await backup_svc.export_json(db, user.id)
    return data


@router.post("/import")
async def import_json(
    body: ImportBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await backup_svc.import_data(
        db,
        user.id,
        content=body.content,
        format=body.format,
        strategy=body.strategy,
        confirm_replace=body.confirm_replace,
    )


@router.post("/import-file")
async def import_file(
    file: UploadFile = File(...),
    format: str = Form("json"),
    strategy: str = Form("skip_duplicate"),
    confirm_replace: bool = Form(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    content = (await file.read()).decode("utf-8", errors="replace")
    name = (file.filename or "").lower()
    fmt = (format or "json").strip().lower()
    # Infer format from extension only when client left default/empty
    if fmt in ("", "json") and name.endswith(".html"):
        fmt = "html"
    elif fmt in ("", "json") and name.endswith(".htm"):
        fmt = "html"
    elif fmt in ("", "json") and name.endswith(".csv"):
        fmt = "csv"
    if fmt not in backup_svc.BACKUP_FORMATS:
        raise api_error("validation", f"Unsupported format: {format}")
    if strategy not in backup_svc.BACKUP_STRATEGIES:
        raise api_error("validation", f"Unsupported strategy: {strategy}")
    return await backup_svc.import_data(
        db,
        user.id,
        content=content,
        format=fmt,
        strategy=strategy,
        confirm_replace=confirm_replace,
    )


def _require_webdav():
    from app.config import get_settings

    if not get_settings().ff_webdav:
        raise api_error("feature_disabled", "WebDAV backup is disabled", 503)


def _require_s3():
    from app.config import get_settings

    if not get_settings().ff_s3_backup:
        raise api_error("feature_disabled", "S3 backup is disabled", 503)


@router.get("/webdav")
async def get_webdav(
    test: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_webdav()
    if test:
        return await remote.test_webdav(db, user.id)
    return await remote.get_webdav_config(db, user.id)


@router.put("/webdav")
async def put_webdav(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_webdav()
    return await remote.save_webdav_config(db, user.id, body)


@router.post("/webdav")
async def post_webdav(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_webdav()
    return await remote.run_webdav_backup(db, user.id)


@router.get("/s3")
async def get_s3(
    test: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_s3()
    if test:
        return await remote.test_s3(db, user.id)
    return await remote.get_s3_config(db, user.id)


@router.put("/s3")
async def put_s3(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_s3()
    return await remote.save_s3_config(db, user.id, body)


@router.post("/s3")
async def post_s3(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_s3()
    return await remote.run_s3_backup(db, user.id)
