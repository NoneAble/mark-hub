"""Regressions for SQLite rebuild retry and FK-safe folder GC."""

from __future__ import annotations

from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.asyncio
async def test_sqlite_rebuild_failure_rolls_back_and_retries(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """An interrupted 0002 rebuild leaves data/schema retryable (RQG-F002)."""
    from app import migrate
    from app.database import Base

    db_path = tmp_path / "interrupted.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_connection, _):  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    migrations = tmp_path / "migrations"
    migrations.mkdir()
    source = migrate.MIGRATIONS_DIR / "0002_fk_constraints.sqlite.sql"
    migration = migrations / source.name
    original_sql = source.read_text(encoding="utf-8")
    needle = "FROM folders__old;\nDROP TABLE folders__old;"
    assert needle in original_sql
    migration.write_text(
        original_sql.replace(
            needle,
            "FROM folders__old;\nSELECT * FROM migration_was_interrupted;\n"
            "DROP TABLE folders__old;",
            1,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", migrations)

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(
                text(
                    "INSERT INTO users "
                    "(id, username, password_hash, must_change_password, created_at, updated_at) "
                    "VALUES ('u1', 'legacy', 'hash', 0, datetime('now'), datetime('now'))"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO folders "
                    "(id, user_id, parent_id, name, sort_order, visibility, is_system, "
                    "created_at, updated_at) VALUES "
                    "('f1', 'u1', NULL, 'Keep folder', 0, 'private', 1, "
                    "datetime('now'), datetime('now'))"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO bookmarks "
                    "(id, user_id, folder_id, title, url, url_normalized, visibility, "
                    "is_favorite, is_archived, sort_order, link_status, created_at, updated_at) "
                    "VALUES ('b1', 'u1', 'f1', 'Keep bookmark', 'https://keep.example', "
                    "'https://keep.example', 'private', 0, 0, 0, 'unknown', "
                    "datetime('now'), datetime('now'))"
                )
            )

        with pytest.raises(Exception, match="migration_was_interrupted"):
            await migrate.run_migrations_on_engine(engine)

        async with engine.connect() as conn:
            table_names = set(
                (
                    await conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'"))
                ).scalars()
            )
            assert "folders" in table_names
            assert "folders__old" not in table_names
            assert (
                await conn.execute(text("SELECT name FROM folders WHERE id='f1'"))
            ).scalar_one() == "Keep folder"
            assert (
                await conn.execute(text("SELECT title FROM bookmarks WHERE id='b1'"))
            ).scalar_one() == "Keep bookmark"
            assert int((await conn.execute(text("PRAGMA foreign_keys"))).scalar_one()) == 1
            versions = set(
                (await conn.execute(text("SELECT version FROM schema_migrations"))).scalars()
            )
            assert "0002_fk_constraints" not in versions

        migration.write_text(original_sql, encoding="utf-8")
        assert await migrate.run_migrations_on_engine(engine) == ["0002_fk_constraints"]

        async with engine.connect() as conn:
            assert (
                await conn.execute(text("SELECT name FROM folders WHERE id='f1'"))
            ).scalar_one() == "Keep folder"
            assert (
                await conn.execute(text("SELECT title FROM bookmarks WHERE id='b1'"))
            ).scalar_one() == "Keep bookmark"
            assert int((await conn.execute(text("PRAGMA foreign_keys"))).scalar_one()) == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_soft_delete_gc_purges_nested_folders_with_foreign_keys_on(
    client: AsyncClient, auth_headers
):
    """Nested stale folders are physically deleted child-first (RQG-F006)."""
    from app.database import async_session_maker
    from app.jobs.scheduler import run_soft_delete_gc
    from app.models import Folder
    from app.utils.timeutil import server_now

    parent = (
        await client.post("/api/v1/folders", headers=auth_headers, json={"name": "GC parent"})
    ).json()
    child = (
        await client.post(
            "/api/v1/folders",
            headers=auth_headers,
            json={"name": "GC child", "parent_id": parent["id"]},
        )
    ).json()
    response = await client.delete(
        f"/api/v1/folders/{parent['id']}?mode=cascade_soft_delete",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    stale_at = server_now() - timedelta(days=31)
    async with async_session_maker() as db:
        rows = (
            (await db.execute(select(Folder).where(Folder.id.in_([parent["id"], child["id"]]))))
            .scalars()
            .all()
        )
        assert len(rows) == 2
        for row in rows:
            row.deleted_at = stale_at
        assert int((await db.execute(text("PRAGMA foreign_keys"))).scalar_one()) == 1
        await db.commit()

    result = await run_soft_delete_gc()
    assert result["folders"] == 2
    async with async_session_maker() as db:
        remaining = (
            (await db.execute(select(Folder.id).where(Folder.id.in_([parent["id"], child["id"]]))))
            .scalars()
            .all()
        )
        assert remaining == []
