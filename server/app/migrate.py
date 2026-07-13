"""Ordered SQLite/Postgres schema migrations (PR-02 / RQG-MIGRATION-001).

Migrations live under ``server/migrations/`` as dialect-specific SQL files:

  NNNN_name.sqlite.sql
  NNNN_name.postgres.sql

Applied versions are recorded in ``schema_migrations``. Legacy databases
created via ``create_all()`` (no schema_migrations) are stamped at baseline
and then receive upgrade migrations that add missing constraints.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

logger = logging.getLogger("markhub.migrate")

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"

# Version stamped on legacy create_all databases before upgrade migrations run.
LEGACY_BASELINE = "0001_init"

_SQLITE_FOREIGN_KEYS_PRAGMA = re.compile(
    r"^\s*PRAGMA\s+foreign_keys\s*=\s*(ON|OFF|1|0)\s*;?\s*$", re.IGNORECASE
)


def _dialect_name(conn: AsyncConnection) -> str:
    name = conn.dialect.name
    if name == "postgresql":
        return "postgres"
    if name.startswith("sqlite"):
        return "sqlite"
    return name


def discover_migrations(dialect: str) -> list[tuple[str, Path]]:
    """Return ordered (version_id, path) pairs for the given dialect."""
    if not MIGRATIONS_DIR.is_dir():
        return []
    suffix = f".{dialect}.sql"
    found: list[tuple[str, Path]] = []
    for path in sorted(MIGRATIONS_DIR.glob(f"*{suffix}")):
        # 0001_init.sqlite.sql → 0001_init
        name = path.name[: -len(suffix)]
        if re.fullmatch(r"\d{4}_[a-z0-9_]+", name):
            found.append((name, path))
    return found


def split_sql(sql: str) -> list[str]:
    """Split a migration file into executable statements.

    Supports ``--`` line comments and ignores empty statements. Does not
    attempt to parse dollar-quoted Postgres bodies that contain ``;`` —
    migrations should use simple statements or DO $$ ... $$ blocks as a
    single statement without internal bare ``;`` terminators outside the body.
    """
    # Strip full-line comments, keep DO blocks intact by splitting on
    # semicolons that are not inside $$ ... $$.
    statements: list[str] = []
    buf: list[str] = []
    in_dollar = False
    for line in sql.splitlines():
        stripped = line.strip()
        if not in_dollar and stripped.startswith("--"):
            continue
        # Track simple $$ dollar-quote toggles (Postgres DO blocks)
        if "$$" in line:
            # count occurrences; odd total flips state per segment
            parts = line.split("$$")
            # number of $$ delimiters = len(parts) - 1
            if (len(parts) - 1) % 2 == 1:
                in_dollar = not in_dollar
        buf.append(line)
        if not in_dollar and stripped.endswith(";"):
            stmt = "\n".join(buf).strip()
            buf = []
            if stmt:
                statements.append(stmt)
    tail = "\n".join(buf).strip()
    if tail:
        statements.append(tail if tail.endswith(";") else tail + ";")
    return statements


async def _table_exists(conn: AsyncConnection, table: str) -> bool:
    dialect = _dialect_name(conn)
    if dialect == "sqlite":
        row = await conn.execute(
            text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": table},
        )
        return row.first() is not None
    row = await conn.execute(
        text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = :n"
        ),
        {"n": table},
    )
    return row.first() is not None


async def _ensure_schema_migrations(conn: AsyncConnection) -> None:
    dialect = _dialect_name(conn)
    if dialect == "sqlite":
        await conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version VARCHAR(128) PRIMARY KEY,
                    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
        )
    else:
        await conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version VARCHAR(128) PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        )


async def _applied_versions(conn: AsyncConnection) -> set[str]:
    result = await conn.execute(text("SELECT version FROM schema_migrations"))
    return {row[0] for row in result.fetchall()}


async def _mark_applied(conn: AsyncConnection, version: str) -> None:
    dialect = _dialect_name(conn)
    if dialect == "sqlite":
        await conn.execute(
            text(
                "INSERT OR IGNORE INTO schema_migrations (version, applied_at) "
                "VALUES (:v, datetime('now'))"
            ),
            {"v": version},
        )
    else:
        await conn.execute(
            text(
                "INSERT INTO schema_migrations (version, applied_at) "
                "VALUES (:v, NOW()) ON CONFLICT (version) DO NOTHING"
            ),
            {"v": version},
        )


async def _stamp_legacy_baseline(conn: AsyncConnection) -> None:
    """Databases created by create_all lack schema_migrations.

    Stamp 0001_init as applied so only upgrade migrations re-run, preserving
    existing admin/Inbox/application rows.
    """
    has_users = await _table_exists(conn, "users")
    has_sm = await _table_exists(conn, "schema_migrations")
    if has_users and has_sm:
        applied = await _applied_versions(conn)
        if not applied:
            logger.info(
                "Legacy schema detected (tables present, empty schema_migrations); "
                "stamping baseline %s",
                LEGACY_BASELINE,
            )
            await _mark_applied(conn, LEGACY_BASELINE)
    elif has_users and not has_sm:
        # Should not happen because we create schema_migrations first, but keep safe
        await _ensure_schema_migrations(conn)
        await _mark_applied(conn, LEGACY_BASELINE)


async def _exec_sql_file(conn: AsyncConnection, path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    for stmt in split_sql(sql):
        await conn.exec_driver_sql(stmt)


def _sqlite_migration_parts(path: Path) -> tuple[list[str], list[str], list[str]]:
    """Split SQLite FK pragmas from the transactional migration body.

    SQLite ignores ``PRAGMA foreign_keys`` while a transaction is active.  A
    migration may therefore put those directives only before or after its SQL
    body; the body itself remains one failure-atomic transaction.
    """
    statements = split_sql(path.read_text(encoding="utf-8"))
    non_pragma_indexes = [
        i for i, stmt in enumerate(statements) if not _SQLITE_FOREIGN_KEYS_PRAGMA.match(stmt)
    ]
    if not non_pragma_indexes:
        return statements, [], []

    first_body = non_pragma_indexes[0]
    last_body = non_pragma_indexes[-1]
    before: list[str] = []
    body: list[str] = []
    after: list[str] = []
    for i, stmt in enumerate(statements):
        if not _SQLITE_FOREIGN_KEYS_PRAGMA.match(stmt):
            body.append(stmt)
        elif i < first_body:
            before.append(stmt)
        elif i > last_body:
            after.append(stmt)
        else:
            raise RuntimeError(
                f"{path.name}: PRAGMA foreign_keys must be outside the migration body"
            )
    return before, body, after


async def _sqlite_begin(conn: AsyncConnection) -> None:
    await conn.exec_driver_sql("BEGIN IMMEDIATE")


async def _sqlite_commit(conn: AsyncConnection) -> None:
    # COMMIT closes the explicit SQLite transaction; conn.commit() clears
    # SQLAlchemy's autobegin bookkeeping on the AUTOCOMMIT connection.
    await conn.exec_driver_sql("COMMIT")
    await conn.commit()


async def _sqlite_rollback(conn: AsyncConnection) -> None:
    try:
        await conn.exec_driver_sql("ROLLBACK")
    finally:
        await conn.rollback()


async def _run_sqlite_migrations(conn: AsyncConnection) -> list[str]:
    """Apply SQLite migrations atomically and leave FK enforcement restored."""
    if conn.in_transaction():
        raise RuntimeError("SQLite migrations require a connection outside a transaction")

    # Ledger creation and legacy stamping form their own small atomic unit.
    await _sqlite_begin(conn)
    try:
        await _ensure_schema_migrations(conn)
        await _stamp_legacy_baseline(conn)
        applied = await _applied_versions(conn)
        await _sqlite_commit(conn)
    except Exception:
        await _sqlite_rollback(conn)
        raise

    newly: list[str] = []
    for version, path in discover_migrations("sqlite"):
        if version in applied:
            continue
        before, body, after = _sqlite_migration_parts(path)
        original_fk = int((await conn.exec_driver_sql("PRAGMA foreign_keys")).scalar_one())
        await conn.commit()
        try:
            for stmt in before:
                await conn.exec_driver_sql(stmt)
            await conn.commit()

            logger.info("Applying migration %s (%s)", version, path.name)
            await _sqlite_begin(conn)
            try:
                for stmt in body:
                    await conn.exec_driver_sql(stmt)
                await _mark_applied(conn, version)
                await _sqlite_commit(conn)
            except Exception:
                await _sqlite_rollback(conn)
                raise
        finally:
            # On failure, restore the connection's incoming setting.  On
            # success, honor the migration's trailing directive (normally ON).
            restore = after or [f"PRAGMA foreign_keys = {original_fk}"]
            for stmt in restore:
                await conn.exec_driver_sql(stmt)
            await conn.commit()

        newly.append(version)
        applied.add(version)
    return newly


async def run_migrations(conn: AsyncConnection) -> list[str]:
    """Apply pending migrations on an open connection.

    SQLite migrations manage an explicit transaction per migration. The
    connection **must not** already be inside a transaction; callers should
    use ``execution_options(isolation_level="AUTOCOMMIT")`` (see ``init_db``).

    Returns the list of newly applied version ids (may be empty).
    """
    dialect = _dialect_name(conn)
    if dialect == "sqlite":
        return await _run_sqlite_migrations(conn)

    await _ensure_schema_migrations(conn)
    await _stamp_legacy_baseline(conn)

    applied = await _applied_versions(conn)
    newly: list[str] = []
    for version, path in discover_migrations(dialect):
        if version in applied:
            continue
        logger.info("Applying migration %s (%s)", version, path.name)
        await _exec_sql_file(conn, path)
        await _mark_applied(conn, version)
        newly.append(version)
        applied.add(version)
    return newly


async def run_migrations_on_engine(engine) -> list[str]:  # type: ignore[no-untyped-def]
    """Apply migrations using the correct isolation mode for the dialect.

    SQLite: AUTOCOMMIT so PRAGMA foreign_keys=OFF in upgrade scripts is honored.
    Postgres: transactional begin() is fine.
    """
    dialect = engine.dialect.name
    if dialect.startswith("sqlite"):
        async with engine.connect() as conn:
            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
            newly = await run_migrations(conn)
            await ensure_search_indexes(conn)
            return newly
    async with engine.begin() as conn:
        newly = await run_migrations(conn)
        await ensure_search_indexes(conn)
        return newly


async def ensure_search_indexes(conn: AsyncConnection) -> None:
    """FTS / tsvector helpers that are safe to re-run after migrations."""
    dialect = _dialect_name(conn)
    if dialect == "sqlite":
        await conn.exec_driver_sql(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
                bookmark_id UNINDEXED,
                title,
                url,
                description,
                tags
            )
            """
        )
    elif dialect == "postgres":
        await conn.exec_driver_sql(
            """
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'bookmarks' AND column_name = 'search_vector'
              ) THEN
                ALTER TABLE bookmarks ADD COLUMN search_vector tsvector;
              END IF;
            END $$;
            """
        )
        await conn.exec_driver_sql(
            """
            CREATE INDEX IF NOT EXISTS ix_bookmarks_search_vector
            ON bookmarks USING GIN (search_vector);
            """
        )
