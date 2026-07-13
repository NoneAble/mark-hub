from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import OpLog
from app.utils.timeutil import iso


async def list_changes(
    db: AsyncSession,
    user_id: str,
    *,
    since: int = 0,
    limit: int = 500,
) -> dict:
    limit = max(1, min(limit, 1000))
    rows = list(
        (
            await db.execute(
                select(OpLog)
                .where(OpLog.user_id == user_id, OpLog.id > since)
                .order_by(OpLog.id.asc())
                .limit(limit + 1)
            )
        )
        .scalars()
        .all()
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    changes = []
    for r in rows:
        snap = None
        if r.snapshot:
            try:
                snap = json.loads(r.snapshot)
            except json.JSONDecodeError:
                snap = None
        changes.append(
            {
                "id": r.id,
                "user_id": r.user_id,
                "entity_type": r.entity_type,
                "entity_id": r.entity_id,
                "action": r.action,
                "snapshot": snap,
                "created_at": iso(r.created_at),
            }
        )
    next_cursor = rows[-1].id if rows else since
    return {
        "changes": changes,
        "next_cursor": next_cursor,
        "has_more": has_more,
    }
