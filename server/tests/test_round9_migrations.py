"""Regression tests for database-migrations subsystem findings.

RQG-MIGRATION-001  — ordered SQLite/Postgres migrations replace create_all
RQG-DATA-CONSTRAINTS-002 — FK graph enforced on Docker SQLite + D1
"""

from __future__ import annotations

import re
import sqlite3
import tempfile
from pathlib import Path

import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

ROOT = Path(__file__).resolve().parents[2]
SERVER_MIG = ROOT / "server" / "migrations"
WORKER_MIG = ROOT / "apps" / "worker" / "migrations"


# ---------------------------------------------------------------------------
# File / layout contracts
# ---------------------------------------------------------------------------


def test_rqg_migration_001_ordered_sqlite_and_postgres_files_exist():
    """RQG-MIGRATION-001: versioned dialect SQL lives under server/migrations."""
    sqlite_files = sorted(SERVER_MIG.glob("*.sqlite.sql"))
    postgres_files = sorted(SERVER_MIG.glob("*.postgres.sql"))
    assert sqlite_files, "missing *.sqlite.sql migrations"
    assert postgres_files, "missing *.postgres.sql migrations"
    # At least init + fk upgrade
    sqlite_ids = [p.name.split(".")[0] for p in sqlite_files]
    postgres_ids = [p.name.split(".")[0] for p in postgres_files]
    assert "0001_init" in sqlite_ids
    assert "0001_init" in postgres_ids
    assert "0002_fk_constraints" in sqlite_ids
    assert "0002_fk_constraints" in postgres_ids
    # Paired versions
    assert set(sqlite_ids) == set(postgres_ids)
    # Ordered numeric prefixes
    assert sqlite_ids == sorted(sqlite_ids)


def test_rqg_migration_001_init_db_does_not_use_create_all():
    """RQG-MIGRATION-001: runtime startup path must not call create_all."""
    database_py = (ROOT / "server" / "app" / "database.py").read_text(encoding="utf-8")
    # Executable create_all calls are forbidden; docstring mentions are OK
    assert "metadata.create_all" not in database_py
    assert "Base.metadata.create_all" not in database_py
    assert "run_migrations" in database_py
    assert "async def init_db" in database_py
    migrate_py = (ROOT / "server" / "app" / "migrate.py").read_text(encoding="utf-8")
    assert "schema_migrations" in migrate_py
    assert "discover_migrations" in migrate_py


def test_rqg_data_constraints_002_folder_parent_fk_in_orm():
    """RQG-DATA-CONSTRAINTS-002: Folder.parent_id is a self-referential FK."""
    entities = (ROOT / "server" / "app" / "models" / "entities.py").read_text(encoding="utf-8")
    assert 'ForeignKey("folders.id")' in entities
    # user_id on clean_issues must also be constrained
    assert re.search(
        r'user_id: Mapped\[str\] = mapped_column\(\s*String\(36\),\s*ForeignKey\("users\.id"\)',
        entities,
        re.M,
    )


def test_rqg_data_constraints_002_d1_fk_migration_checked_in():
    """RQG-DATA-CONSTRAINTS-002: D1 has a versioned FK migration after init."""
    mig = WORKER_MIG / "0005_foreign_keys.sql"
    assert mig.is_file(), "missing apps/worker/migrations/0005_foreign_keys.sql"
    text_sql = mig.read_text(encoding="utf-8")
    assert "FOREIGN KEY" in text_sql
    assert "REFERENCES folders" in text_sql or "REFERENCES folders__fk" in text_sql
    assert "REFERENCES users" in text_sql
    assert "REFERENCES bookmarks" in text_sql
    # Init schema historically lacked FKs — upgrade migration must rebuild
    assert "folders__old" in text_sql
    assert "bookmarks__old" in text_sql


def test_rqg_data_constraints_002_worker_enables_foreign_keys():
    """RQG-DATA-CONSTRAINTS-002: Worker enables PRAGMA foreign_keys per request."""
    index = (ROOT / "apps" / "worker" / "src" / "index.ts").read_text(encoding="utf-8")
    assert "enableForeignKeys" in index
    assert "PRAGMA foreign_keys = ON" in index
    assert "await enableForeignKeys(env)" in index


# ---------------------------------------------------------------------------
# Live SQLite migration + constraint behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rqg_migration_001_fresh_install_records_versions_and_bootstraps():
    """Fresh DB applies ordered migrations, then admin/Inbox bootstrap preserves data."""
    from app.domain.bootstrap import bootstrap_admin_and_inbox
    from app.migrate import discover_migrations, run_migrations_on_engine

    fd, path = tempfile.mkstemp(suffix="-mig-fresh.db")
    import os

    os.close(fd)
    url = f"sqlite+aiosqlite:///{path}"
    eng = create_async_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(eng.sync_engine, "connect")
    def _fk(dbapi_connection, _):  # type: ignore[no-untyped-def]
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    try:
        applied = await run_migrations_on_engine(eng)
        expected = [v for v, _ in discover_migrations("sqlite")]
        assert applied == expected
        assert "0001_init" in applied
        assert "0002_fk_constraints" in applied

        Session = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
        async with Session() as session:
            user = await bootstrap_admin_and_inbox(session)
            await session.commit()
            admin_id = user.id
            username = user.username

        # Re-run migrations: idempotent, preserves admin + inbox
        applied2 = await run_migrations_on_engine(eng)
        assert applied2 == []

        async with Session() as session:
            from app.models import Folder, User
            from sqlalchemy import select

            users = (await session.execute(select(User))).scalars().all()
            assert len(users) == 1
            assert users[0].id == admin_id
            assert users[0].username == username
            inbox = (
                await session.execute(
                    select(Folder).where(Folder.user_id == admin_id, Folder.is_system == True)  # noqa: E712
                )
            ).scalar_one()
            assert inbox.name == "Inbox"
            assert inbox.parent_id is None
    finally:
        await eng.dispose()
        Path(path).unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_rqg_migration_001_upgrade_from_legacy_create_all_snapshot():
    """Prior create_all() snapshot is stamped, upgraded, and keeps application rows."""
    from app.database import Base
    from app.migrate import run_migrations_on_engine
    from app.models import Bookmark, Folder, User
    from app.security.auth import hash_password
    from app.utils.timeutil import server_now

    fd, path = tempfile.mkstemp(suffix="-mig-legacy.db")
    import os

    os.close(fd)
    url = f"sqlite+aiosqlite:///{path}"
    eng = create_async_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(eng.sync_engine, "connect")
    def _fk(dbapi_connection, _):  # type: ignore[no-untyped-def]
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    try:
        # Simulate pre-migration deployment: create_all only
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        Session = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
        async with Session() as session:
            user = User(
                username="legacy-admin",
                password_hash=hash_password("legacy-pass-1234"),
                must_change_password=False,
                created_at=server_now(),
                updated_at=server_now(),
            )
            session.add(user)
            await session.flush()
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
            session.add(inbox)
            await session.flush()
            bm = Bookmark(
                user_id=user.id,
                folder_id=inbox.id,
                title="Keep Me",
                url="https://legacy.example/",
                url_normalized="https://legacy.example/",
                created_at=server_now(),
                updated_at=server_now(),
            )
            session.add(bm)
            await session.commit()
            user_id, inbox_id, bm_id = user.id, inbox.id, bm.id

        applied = await run_migrations_on_engine(eng)

        # Baseline stamped → only upgrade migrations apply
        assert "0001_init" not in applied
        assert "0002_fk_constraints" in applied

        async with Session() as session:
            from sqlalchemy import select

            u = (await session.execute(select(User).where(User.id == user_id))).scalar_one()
            assert u.username == "legacy-admin"
            f = (await session.execute(select(Folder).where(Folder.id == inbox_id))).scalar_one()
            assert f.is_system is True
            b = (await session.execute(select(Bookmark).where(Bookmark.id == bm_id))).scalar_one()
            assert b.title == "Keep Me"

            # FK graph now present on folders.parent_id
            rows = (
                await session.execute(text("PRAGMA foreign_key_list(folders)"))
            ).fetchall()
            parent_fks = [r for r in rows if r[3] == "parent_id"]  # from column
            assert parent_fks, f"expected parent_id FK on folders, got {rows}"
    finally:
        await eng.dispose()
        Path(path).unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_rqg_data_constraints_002_sqlite_rejects_orphan_bookmark_and_parent():
    """Direct constraint regression: orphan folder_id / parent_id rejected when FK on."""
    from app.migrate import run_migrations_on_engine

    fd, path = tempfile.mkstemp(suffix="-mig-fk.db")
    import os

    os.close(fd)
    url = f"sqlite+aiosqlite:///{path}"
    eng = create_async_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(eng.sync_engine, "connect")
    def _fk(dbapi_connection, _):  # type: ignore[no-untyped-def]
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    try:
        await run_migrations_on_engine(eng)

        async with eng.begin() as conn:
            # Confirm pragma is live on this connection
            fk_on = (await conn.execute(text("PRAGMA foreign_keys"))).scalar()
            assert int(fk_on) == 1

            await conn.execute(
                text(
                    "INSERT INTO users (id, username, password_hash, must_change_password, created_at, updated_at) "
                    "VALUES ('u1', 'a', 'h', 0, datetime('now'), datetime('now'))"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) "
                    "VALUES ('f1', 'u1', NULL, 'Inbox', 0, 'private', 1, datetime('now'), datetime('now'))"
                )
            )

            # Orphan bookmark.folder_id
            with pytest.raises(Exception):
                await conn.execute(
                    text(
                        "INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized, "
                        "visibility, is_favorite, is_archived, sort_order, link_status, created_at, updated_at) "
                        "VALUES ('b1', 'u1', 'missing-folder', 'x', 'https://x', 'https://x', "
                        "'private', 0, 0, 0, 'unknown', datetime('now'), datetime('now'))"
                    )
                )
            await conn.rollback()

        # New transaction after rollback
        async with eng.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO users (id, username, password_hash, must_change_password, created_at, updated_at) "
                    "VALUES ('u1', 'a', 'h', 0, datetime('now'), datetime('now'))"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) "
                    "VALUES ('f1', 'u1', NULL, 'Inbox', 0, 'private', 1, datetime('now'), datetime('now'))"
                )
            )
            # Orphan parent_id
            with pytest.raises(Exception):
                await conn.execute(
                    text(
                        "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) "
                        "VALUES ('f2', 'u1', 'no-such-parent', 'Child', 0, 'private', 0, datetime('now'), datetime('now'))"
                    )
                )
    finally:
        await eng.dispose()
        Path(path).unlink(missing_ok=True)


def test_rqg_data_constraints_002_d1_migration_sql_enforces_bookmark_folder_fk():
    """Apply D1 migration chain offline with sqlite3 and prove FK rejection."""
    fd, path = tempfile.mkstemp(suffix="-d1-fk.db")
    import os

    os.close(fd)
    try:
        con = sqlite3.connect(path)
        con.execute("PRAGMA foreign_keys=ON")
        # Apply ordered D1 migrations
        for name in sorted(p.name for p in WORKER_MIG.glob("*.sql")):
            sql = (WORKER_MIG / name).read_text(encoding="utf-8")
            con.executescript(sql)
        # foreign_key_list must report bookmark → folder
        rows = con.execute("PRAGMA foreign_key_list(bookmarks)").fetchall()
        assert any(r[2] == "folders" and r[3] == "folder_id" for r in rows), rows
        parent_rows = con.execute("PRAGMA foreign_key_list(folders)").fetchall()
        assert any(r[3] == "parent_id" for r in parent_rows), parent_rows

        con.execute(
            "INSERT INTO users (id, username, password_hash, must_change_password, created_at, updated_at) "
            "VALUES ('u1','a','h',1,datetime('now'),datetime('now'))"
        )
        con.execute(
            "INSERT INTO folders (id, user_id, parent_id, name, sort_order, visibility, is_system, created_at, updated_at) "
            "VALUES ('f1','u1',NULL,'Inbox',0,'private',1,datetime('now'),datetime('now'))"
        )
        con.commit()
        with pytest.raises(sqlite3.IntegrityError):
            con.execute(
                "INSERT INTO bookmarks (id, user_id, folder_id, title, url, url_normalized, "
                "visibility, is_favorite, is_archived, sort_order, link_status, created_at, updated_at) "
                "VALUES ('b1','u1','ghost','t','https://t','https://t',"
                "'private',0,0,0,'unknown',datetime('now'),datetime('now'))"
            )
        con.close()
    finally:
        Path(path).unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_rqg_data_constraints_002_sqlite_pragma_enabled_on_app_engine():
    """App engine connect hook enables PRAGMA foreign_keys=ON."""
    from app.database import DATABASE_URL, engine

    assert DATABASE_URL.startswith("sqlite")
    async with engine.connect() as conn:
        val = (await conn.execute(text("PRAGMA foreign_keys"))).scalar()
        assert int(val) == 1
