import os
import tempfile

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Use temp DB before app import side effects
_fd, _db_path = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_db_path}"
os.environ["JWT_SECRET"] = "test-jwt-secret"
os.environ["MARKHUB_MASTER_KEY"] = "test-master-key-32-bytes-long!!"
os.environ["DEFAULT_ADMIN_USERNAME"] = "admin"
os.environ["DEFAULT_ADMIN_PASSWORD"] = "admin123"
os.environ["FORCE_ADMIN_PASSWORD_CHANGE"] = "true"

from app.config import get_settings

get_settings.cache_clear()

from app.database import Base, async_session_maker, engine, init_db  # noqa: E402
from app.domain.bootstrap import bootstrap_admin_and_inbox  # noqa: E402
from app.main import app  # noqa: E402


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    # Fresh schema per test via ordered migrations (not create_all)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        # Drop migration ledger + FTS virtual tables so init_db re-applies cleanly
        await conn.exec_driver_sql("DROP TABLE IF EXISTS schema_migrations")
        await conn.exec_driver_sql("DROP TABLE IF EXISTS bookmarks_fts")
    await init_db()
    async with async_session_maker() as session:
        await bootstrap_admin_and_inbox(session)
        await session.commit()
    yield


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def auth_headers(client: AsyncClient):
    r = await client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "admin123"},
    )
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    # Clear forced password change so protected routes work (F-003)
    if r.json().get("must_change_password"):
        cr = await client.put(
            "/api/v1/auth/credentials",
            headers=headers,
            json={
                "current_password": "admin123",
                "new_password": "admin1234",
            },
        )
        assert cr.status_code == 200, cr.text
        # re-login for a clean session
        r2 = await client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "admin1234"},
        )
        assert r2.status_code == 200, r2.text
        headers = {"Authorization": f"Bearer {r2.json()['access_token']}"}
    return headers
