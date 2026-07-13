from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.security.auth import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.utils.errors import api_error
from app.utils.timeutil import server_now

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


class CredentialsBody(BaseModel):
    current_password: str
    new_username: str | None = None
    new_password: str | None = None


@router.post("/login")
async def login(body: LoginBody, db: AsyncSession = Depends(get_db)):
    from sqlalchemy import select

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise api_error("invalid_credentials", "Invalid username or password", 401)
    token = create_access_token(
        {"sub": user.username, "user_id": user.id}
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "must_change_password": user.must_change_password,
        "user": {
            "id": user.id,
            "username": user.username,
            "must_change_password": user.must_change_password,
        },
    }


@router.post("/logout")
async def logout(_: User = Depends(get_current_user)):
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "username": user.username,
        "must_change_password": user.must_change_password,
    }


@router.put("/credentials")
async def update_credentials(
    body: CredentialsBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not verify_password(body.current_password, user.password_hash):
        raise api_error("invalid_credentials", "Current password incorrect", 401)
    if body.new_username:
        user.username = body.new_username.strip()
    if body.new_password:
        if len(body.new_password) < 6:
            raise api_error("validation", "Password must be at least 6 characters")
        user.password_hash = hash_password(body.new_password)
        user.must_change_password = False
    user.updated_at = server_now()
    await db.flush()
    return {
        "id": user.id,
        "username": user.username,
        "must_change_password": user.must_change_password,
    }
