from collections.abc import AsyncGenerator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()


def _normalize_db_url(url: str) -> str:
    """Accept postgres:// / postgresql:// and force async drivers (F-015)."""
    if url.startswith("postgres://"):
        url = "postgresql+asyncpg://" + url[len("postgres://") :]
    elif url.startswith("postgresql://") and "+asyncpg" not in url:
        url = "postgresql+asyncpg://" + url[len("postgresql://") :]
    elif url.startswith("sqlite://") and "+aiosqlite" not in url:
        url = "sqlite+aiosqlite://" + url[len("sqlite://") :]
    return url


DATABASE_URL = _normalize_db_url(settings.database_url)

_engine_kwargs: dict = {"echo": settings.debug, "future": True}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_async_engine(DATABASE_URL, **_engine_kwargs)


# RQG-DATA-CONSTRAINTS-002: SQLite disables FK checks unless PRAGMA is set per connection.
if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_enable_foreign_keys(dbapi_connection, _connection_record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """Apply ordered migrations then ensure search indexes (PR-02 / RQG-MIGRATION-001).

    Replaces create_all() so Docker SQLite/Postgres installs have a versioned
    upgrade path. Bootstrap (admin/Inbox) runs after this in app lifespan.
    """
    from app import models  # noqa: F401 — keep metadata import for ORM consumers
    from app.migrate import run_migrations_on_engine

    await run_migrations_on_engine(engine)
