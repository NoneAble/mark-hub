from datetime import UTC, datetime


def server_now() -> datetime:
    """All write paths use server clock (KD-28). Store as naive UTC for SQLite simplicity."""
    return datetime.now(UTC).replace(tzinfo=None)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.isoformat() + "Z"
    return dt.isoformat()
