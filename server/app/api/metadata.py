from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.domain.metadata import SAFE_ICON_NAME, favicons_dir, fetch_page_metadata
from app.models import User
from app.security.auth import get_current_user
from app.utils.errors import api_error, not_found

router = APIRouter(prefix="/metadata", tags=["metadata"])

# Served outside the /api/v1 prefix so stored icon paths stay short/stable
icons_router = APIRouter(prefix="/api/icons", tags=["metadata"])

_ICON_MEDIA_TYPES = {
    "png": "image/png",
    "ico": "image/x-icon",
    "svg": "image/svg+xml",
    "jpg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


class MetadataBody(BaseModel):
    url: str


@router.post("")
async def fetch_metadata(
    body: MetadataBody,
    user: User = Depends(get_current_user),
):
    try:
        return await fetch_page_metadata(body.url)
    except ValueError as e:
        raise api_error("fetch_blocked", str(e), 400) from e
    except Exception as e:
        raise api_error("fetch_failed", f"Could not fetch metadata: {e}", 502) from e


@icons_router.get("/favicons/{name}")
async def get_favicon(name: str):
    if not SAFE_ICON_NAME.fullmatch(name):
        raise not_found("Icon not found")
    path = favicons_dir() / name
    if not path.is_file():
        raise not_found("Icon not found")
    ext = name.rsplit(".", 1)[-1]
    return FileResponse(
        path,
        media_type=_ICON_MEDIA_TYPES.get(ext, "application/octet-stream"),
        headers={"Cache-Control": "public, max-age=604800, immutable"},
    )
