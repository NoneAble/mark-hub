import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health(client: AsyncClient):
    r = await client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_login_and_me(client: AsyncClient, auth_headers):
    r = await client.get("/api/v1/auth/me", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["username"] == "admin"
    # auth_headers fixture clears forced password change for other tests
    assert r.json()["must_change_password"] is False


@pytest.mark.asyncio
async def test_login_must_change_password_flag(client: AsyncClient):
    r = await client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "admin123"},
    )
    assert r.status_code == 200
    assert r.json()["must_change_password"] is True


@pytest.mark.asyncio
async def test_folder_bookmark_crud(client: AsyncClient, auth_headers):
    h = auth_headers
    # list folders — inbox present
    r = await client.get("/api/v1/folders", headers=h)
    assert r.status_code == 200
    folders = r.json()["items"]
    assert any(f["is_system"] for f in folders)
    inbox = next(f for f in folders if f["is_system"])

    # create folder
    r = await client.post(
        "/api/v1/folders",
        headers=h,
        json={"name": "Dev", "visibility": "public"},
    )
    assert r.status_code == 200
    folder = r.json()
    assert folder["name"] == "Dev"

    # cannot delete system
    r = await client.delete(f"/api/v1/folders/{inbox['id']}", headers=h)
    assert r.status_code == 400

    # create bookmark
    r = await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "Example",
            "url": "https://example.com/path?utm_source=x",
            "folder_id": folder["id"],
            "visibility": "public",
            "tags": ["demo"],
        },
    )
    assert r.status_code == 200
    bm = r.json()
    assert "utm_source" not in bm["url_normalized"]
    assert bm["url_normalized"] == "https://example.com/path"

    # list
    r = await client.get("/api/v1/bookmarks", headers=h)
    assert r.json()["total"] >= 1

    # public nav includes public folder+bookmark
    r = await client.get("/api/v1/nav/public")
    assert r.status_code == 200
    tree = r.json()["tree"]
    assert any(n.get("name") == "Dev" for n in tree)

    # changes log
    r = await client.get("/api/v1/changes?since=0", headers=h)
    assert r.status_code == 200
    assert len(r.json()["changes"]) >= 1


@pytest.mark.asyncio
async def test_visibility_private_parent(client: AsyncClient, auth_headers):
    h = auth_headers
    r = await client.post(
        "/api/v1/folders",
        headers=h,
        json={"name": "Secret", "visibility": "private"},
    )
    folder = r.json()
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "Hidden Public",
            "url": "https://hidden.example.com",
            "folder_id": folder["id"],
            "visibility": "public",
        },
    )
    r = await client.get("/api/v1/nav/public")
    tree = r.json()["tree"]

    def walk(nodes):
        for n in nodes:
            if n.get("title") == "Hidden Public":
                return True
            if n.get("children") and walk(n["children"]):
                return True
        return False

    assert walk(tree) is False


@pytest.mark.asyncio
async def test_import_export_json(client: AsyncClient, auth_headers):
    h = auth_headers
    payload = {
        "bookmarks": [
            {"title": "A", "url": "https://a.test", "category": "Imported"},
            {"title": "B", "url": "https://b.test", "category": "Imported"},
        ]
    }
    import json

    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": json.dumps(payload),
            "format": "json",
            "strategy": "skip_duplicate",
        },
    )
    assert r.status_code == 200
    assert r.json()["created"] == 2

    # skip duplicates
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": json.dumps(payload),
            "format": "json",
            "strategy": "skip_duplicate",
        },
    )
    assert r.json()["skipped"] == 2

    r = await client.get("/api/v1/backup/export?format=json", headers=h)
    assert r.status_code == 200
    assert r.json()["format"] == "markhub-json"
    assert len(r.json()["bookmarks"]) >= 2


@pytest.mark.asyncio
async def test_s3_config_masking(client: AsyncClient, auth_headers):
    h = auth_headers
    r = await client.put(
        "/api/v1/backup/s3",
        headers=h,
        json={
            "enabled": False,
            "endpoint": "https://example.r2.cloudflarestorage.com",
            "region": "auto",
            "bucket": "markhub-backups",
            "key_prefix": "markhub-backup",
            "access_key_id": "AKIA",
            "secret_access_key": "super-secret",
            "keep_backups": 7,
            "backup_time": "03:00",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["secret_set"] is True
    assert "secret_access_key" not in body or body.get("secret_access_key") in (None, "")
    assert body["key_prefix"].endswith("/")
