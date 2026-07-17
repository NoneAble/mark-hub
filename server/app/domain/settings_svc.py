from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Setting
from app.security.crypto import decrypt_secret, encrypt_secret

SECRET_KEYS = {
    "webdav_password",
    "s3_secret_access_key",
}


async def get_setting(db: AsyncSession, user_id: str, key: str, default: str = "") -> str:
    row = (
        await db.execute(
            select(Setting).where(Setting.user_id == user_id, Setting.key == key)
        )
    ).scalar_one_or_none()
    if not row:
        return default
    if row.is_secret:
        return decrypt_secret(row.value)
    return row.value


async def set_setting(
    db: AsyncSession,
    user_id: str,
    key: str,
    value: str,
    *,
    is_secret: bool = False,
) -> None:
    row = (
        await db.execute(
            select(Setting).where(Setting.user_id == user_id, Setting.key == key)
        )
    ).scalar_one_or_none()
    stored = encrypt_secret(value) if is_secret else value
    if row is None:
        db.add(Setting(user_id=user_id, key=key, value=stored, is_secret=is_secret))
    else:
        row.value = stored
        row.is_secret = is_secret
    await db.flush()


async def get_json_setting(db: AsyncSession, user_id: str, key: str, default: Any = None) -> Any:
    raw = await get_setting(db, user_id, key, "")
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


async def set_json_setting(db: AsyncSession, user_id: str, key: str, value: Any) -> None:
    await set_setting(db, user_id, key, json.dumps(value, ensure_ascii=False), is_secret=False)


async def get_all_public_settings(db: AsyncSession, user_id: str) -> dict[str, Any]:
    rows = (
        await db.execute(select(Setting).where(Setting.user_id == user_id))
    ).scalars().all()
    out: dict[str, Any] = {}
    for r in rows:
        if r.is_secret or r.key in SECRET_KEYS:
            out[f"{r.key}_set"] = bool(r.value)
            continue
        try:
            out[r.key] = json.loads(r.value)
        except (json.JSONDecodeError, TypeError):
            out[r.key] = r.value
    # defaults
    out.setdefault("theme", "system")
    out.setdefault("language", "auto")
    out.setdefault("site_title", "MarkHub")
    out.setdefault("card_density", "comfortable")
    return out
