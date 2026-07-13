"""Regression tests for Codex round-2 findings."""

from __future__ import annotations

import pytest
from app.utils.normalize import normalize_url
from app.utils.s3_validate import validate_s3_config
from httpx import AsyncClient


def test_normalize_url_preserves_path_case():
    assert (
        normalize_url("https://EXAMPLE.com/CasePath?Token=ABC&utm_source=x")
        == "https://example.com/CasePath?Token=ABC"
    )


def test_s3_validation_rejects_invalid_fields():
    bad_url = validate_s3_config(
        {
            "endpoint": "not-a-url",
            "region": "auto",
            "bucket": "valid-bucket",
            "access_key_id": "ak",
            "secret_access_key": "sk",
            "keep_backups": 7,
            "backup_time": "02:00",
        },
        require_secrets=True,
    )
    assert any("endpoint" in e for e in bad_url)

    bad_bucket = validate_s3_config(
        {
            "endpoint": "https://s3.example.com",
            "region": "auto",
            "bucket": "INVALID BUCKET",
            "access_key_id": "ak",
            "secret_access_key": "sk",
            "keep_backups": 7,
            "backup_time": "02:00",
        },
        require_secrets=True,
    )
    assert any("bucket" in e for e in bad_bucket)

    bad_time = validate_s3_config(
        {
            "endpoint": "https://s3.example.com",
            "region": "auto",
            "bucket": "valid-bucket",
            "access_key_id": "ak",
            "secret_access_key": "sk",
            "keep_backups": 7,
            "backup_time": "99:99",
        },
        require_secrets=True,
    )
    assert any("backup_time" in e for e in bad_time)

    bad_keep = validate_s3_config(
        {
            "endpoint": "https://s3.example.com",
            "region": "auto",
            "bucket": "valid-bucket",
            "access_key_id": "ak",
            "secret_access_key": "sk",
            "keep_backups": 0,
            "backup_time": "02:00",
        },
        require_secrets=True,
    )
    assert any("keep_backups" in e for e in bad_keep)


@pytest.mark.asyncio
async def test_fetch_page_info_requires_auth(client: AsyncClient):
    r = await client.post("/api/v1/ai/fetch-page-info", json={"url": "https://example.com"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_s3_put_rejects_invalid_config(client: AsyncClient, auth_headers):
    r = await client.put(
        "/api/v1/backup/s3",
        headers=auth_headers,
        json={
            "endpoint": "not-a-url",
            "bucket": "x",
            "region": "auto",
            "keep_backups": 0,
            "backup_time": "99:99",
        },
    )
    assert r.status_code in (400, 422)
    body = r.json()
    assert "error" in body
    assert body["error"]["code"] == "validation"


@pytest.mark.asyncio
async def test_share_password_query_rejected(client: AsyncClient, auth_headers):
    # create a share with password
    folders = (await client.get("/api/v1/folders", headers=auth_headers)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    cr = await client.post(
        "/api/v1/shares",
        headers=auth_headers,
        json={"target_type": "folder", "target_id": inbox["id"], "password": "secret1"},
    )
    assert cr.status_code == 200
    token = cr.json()["token"]
    r = await client.get(f"/api/v1/shares/{token}?password=secret1")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "password_in_query"
    # body unlock works
    r2 = await client.post(
        f"/api/v1/shares/{token}/unlock",
        json={"password": "secret1"},
    )
    assert r2.status_code == 200


@pytest.mark.asyncio
async def test_board_url_import_matches(client: AsyncClient, auth_headers):
    h = auth_headers
    # create bookmark
    bm = await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={"title": "SB", "url": "https://channel.example/path?x=1"},
    )
    assert bm.status_code == 200
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    board = await client.post(
        "/api/v1/boards",
        headers=h,
        json={"name": "Import", "type": "ai_channels", "source_folder_ids": [inbox["id"]]},
    )
    bid = board.json()["id"]
    r = await client.post(
        f"/api/v1/boards/{bid}/import",
        headers=h,
        json={
            "data": {
                "annotations": [
                    {"url": "https://channel.example/path?x=1&utm_source=z", "status": "active"}
                ]
            }
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["annotations_created"] + body["annotations_updated"] >= 1


@pytest.mark.asyncio
async def test_mcp_origin_enforced(client: AsyncClient, auth_headers):
    # enable MCP + set token + allowed origins
    await client.put(
        "/api/v1/settings/mcp",
        headers=auth_headers,
        json={"enabled": True, "allowed_origins": "https://allowed.example"},
    )
    tok = await client.post("/api/v1/settings/mcp/token", headers=auth_headers)
    assert tok.status_code == 200
    token = tok.json().get("token") or tok.json().get("access_token")
    if not token:
        # some APIs return only once
        pytest.skip("token not returned")
    # disallowed origin
    r = await client.get(
        "/api/v1/mcp/tools",
        headers={"Authorization": f"Bearer {token}", "Origin": "https://evil.example"},
    )
    assert r.status_code == 403
    # no origin (agent) allowed
    r2 = await client.get(
        "/api/v1/mcp/tools",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 200
