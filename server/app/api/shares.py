from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.domain import shares as svc
from app.models import User
from app.security.auth import get_current_user
from app.utils.errors import api_error

router = APIRouter(prefix="/shares", tags=["shares"])


class ShareCreate(BaseModel):
    target_type: str
    target_id: str
    password: str | None = None
    # Optional absolute expiry (ISO-8601). Past values create an already-expired link (410 on resolve).
    expires_at: datetime | None = Field(
        default=None,
        description="Optional share expiry timestamp (UTC). Null means never expires.",
    )


class ShareUnlock(BaseModel):
    password: str


def _client_ip(request: Request) -> str | None:
    # The ASGI server may rewrite request.client for explicitly trusted proxies.
    # Raw forwarding headers are caller-controlled on the direct Docker path.
    if request.client:
        return request.client.host
    return None


@router.get("")
async def list_shares(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return {"items": await svc.list_shares(db, user.id)}


@router.post("")
async def create_share(
    body: ShareCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.create_share(
        db,
        user.id,
        target_type=body.target_type,
        target_id=body.target_id,
        password=body.password,
        expires_at=body.expires_at,
    )


@router.get("/{token}")
async def get_share(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Public share view. Password-protected shares must POST /unlock (F-018)."""
    # Reject password in query string — secrets must not appear in URLs/logs
    if "password" in request.query_params:
        raise api_error(
            "password_in_query",
            "Pass password via POST /api/v1/shares/{token}/unlock body, not query string",
            400,
        )
    return await svc.get_share(db, token, password=None, client_ip=_client_ip(request))


@router.post("/{token}/unlock")
async def unlock_share(
    token: str,
    body: ShareUnlock,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Body-based password unlock with per-token/IP rate limiting (F-018)."""
    return await svc.get_share(
        db,
        token,
        password=body.password,
        client_ip=_client_ip(request),
    )


@router.delete("/{token}")
async def delete_share(
    token: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await svc.delete_share(db, user.id, token)
