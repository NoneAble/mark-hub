from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Folder, Setting, User
from app.security.auth import hash_password
from app.utils.timeutil import server_now


async def bootstrap_admin_and_inbox(db: AsyncSession) -> User:
    """Empty DB: create single admin + system inbox (KD-29)."""
    settings = get_settings()
    result = await db.execute(select(User).limit(1))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(
            username=settings.default_admin_username,
            password_hash=hash_password(settings.default_admin_password),
            must_change_password=settings.force_admin_password_change,
            created_at=server_now(),
            updated_at=server_now(),
        )
        db.add(user)
        await db.flush()

    # Ensure inbox
    inbox_q = await db.execute(
        select(Folder).where(
            Folder.user_id == user.id,
            Folder.is_system == True,  # noqa: E712
            Folder.deleted_at.is_(None),
        )
    )
    inbox = inbox_q.scalar_one_or_none()
    if inbox is None:
        inbox = Folder(
            user_id=user.id,
            parent_id=None,
            name="Inbox",
            sort_order=0,
            visibility="private",
            is_system=True,
            created_at=server_now(),
            updated_at=server_now(),
        )
        db.add(inbox)
        await db.flush()

    # settings.inbox_folder_id
    s_q = await db.execute(
        select(Setting).where(Setting.user_id == user.id, Setting.key == "inbox_folder_id")
    )
    if s_q.scalar_one_or_none() is None:
        db.add(
            Setting(
                user_id=user.id,
                key="inbox_folder_id",
                value=inbox.id,
                is_secret=False,
            )
        )
    await db.flush()
    return user


async def get_inbox_folder_id(db: AsyncSession, user_id: str) -> str:
    s_q = await db.execute(
        select(Setting).where(Setting.user_id == user_id, Setting.key == "inbox_folder_id")
    )
    s = s_q.scalar_one_or_none()
    if s and s.value:
        return s.value
    f_q = await db.execute(
        select(Folder).where(
            Folder.user_id == user_id,
            Folder.is_system == True,  # noqa: E712
            Folder.deleted_at.is_(None),
        )
    )
    f = f_q.scalar_one()
    return f.id
