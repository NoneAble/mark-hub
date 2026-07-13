from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import OpLog
from app.utils.timeutil import server_now


async def write_op(
    db: AsyncSession,
    user_id: str,
    entity_type: str,
    entity_id: str,
    action: str,
    snapshot: dict[str, Any] | None = None,
) -> OpLog:
    """Append op_log row. Never include secrets in snapshot (KD-33)."""
    row = OpLog(
        user_id=user_id,
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        snapshot=json.dumps(snapshot, ensure_ascii=False) if snapshot is not None else None,
        created_at=server_now(),
    )
    db.add(row)
    await db.flush()
    return row
