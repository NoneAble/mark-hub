"""Regression tests for Codex round-5 findings (R4-F00x)."""

from __future__ import annotations

import pytest
from app.api import system as system_api
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_metrics_increment_on_requests(client: AsyncClient):
    """R4-F002: middleware must advance requests_total."""
    before = (await client.get("/api/v1/metrics")).json()["requests_total"]
    await client.get("/api/v1/health")
    await client.get("/api/v1/version")
    after = (await client.get("/api/v1/metrics")).json()
    assert after["requests_total"] > before
    assert "errors_5xx" in after


@pytest.mark.asyncio
async def test_metrics_record_5xx(client: AsyncClient):
    """R4-F002: 5xx responses increment errors_5xx."""
    before = (await client.get("/api/v1/metrics")).json()["errors_5xx"]
    # Force a 5xx via record_request helper path (middleware uses same counter)
    system_api.record_request(status_code=500)
    after = (await client.get("/api/v1/metrics")).json()["errors_5xx"]
    assert after >= before + 1


@pytest.mark.asyncio
async def test_batch_nested_payload_move(client: AsyncClient, auth_headers):
    """R4-F014: nested payload is the canonical batch shape."""
    h = auth_headers
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    f2 = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "Batch Target R5"},
        )
    ).json()
    bm = (
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={"title": "B", "url": "https://batch-r5.example/", "folder_id": inbox["id"]},
        )
    ).json()
    r = await client.post(
        "/api/v1/bookmarks/batch",
        headers=h,
        json={
            "action": "move",
            "ids": [bm["id"]],
            "payload": {"folder_id": f2["id"]},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 1
    got = (await client.get(f"/api/v1/bookmarks/{bm['id']}", headers=h)).json()
    assert got["folder_id"] == f2["id"]


@pytest.mark.asyncio
async def test_batch_top_level_alias_still_works(client: AsyncClient, auth_headers):
    """R4-F014: top-level folder_id is accepted as alias into payload."""
    h = auth_headers
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    f2 = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "Alias Target"},
        )
    ).json()
    bm = (
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={"title": "A", "url": "https://alias-r5.example/", "folder_id": inbox["id"]},
        )
    ).json()
    r = await client.post(
        "/api/v1/bookmarks/batch",
        headers=h,
        json={"action": "move", "ids": [bm["id"]], "folder_id": f2["id"]},
    )
    assert r.status_code == 200, r.text
    got = (await client.get(f"/api/v1/bookmarks/{bm['id']}", headers=h)).json()
    assert got["folder_id"] == f2["id"]


@pytest.mark.asyncio
async def test_backup_html_export_escapes(client: AsyncClient, auth_headers):
    """R4-F005: bookmark HTML export escapes titles/URLs."""
    h = auth_headers
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": '"><img src=x onerror=alert(1)>',
            "url": "https://safe.example/path?a=1&b=2",
        },
    )
    r = await client.get("/api/v1/backup/export?format=html", headers=h)
    assert r.status_code == 200, r.text
    # Must not emit a raw HTML tag from title (escaped form is fine)
    assert "<img" not in r.text
    assert "&lt;img" in r.text or "img src=x" not in r.text
    assert "safe.example" in r.text


@pytest.mark.asyncio
async def test_share_rate_limit_persists(client: AsyncClient, auth_headers):
    """Unlock throttling is durable and ignores spoofed forwarding headers."""
    h = auth_headers
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    share = (
        await client.post(
            "/api/v1/shares",
            headers=h,
            json={
                "target_type": "folder",
                "target_id": inbox["id"],
                "password": "secret-pass",
            },
        )
    ).json()
    token = share["token"]

    valid = await client.post(
        f"/api/v1/shares/{token}/unlock",
        headers={"X-Forwarded-For": "198.51.100.1"},
        json={"password": "secret-pass"},
    )
    assert valid.status_code == 200, valid.text

    # A direct Docker caller must not gain a fresh bucket by rotating this header.
    statuses: list[int] = []
    for attempt in range(15):
        transport = ASGITransport(
            app=app, client=(f"203.0.113.{attempt + 1}", 50000 + attempt)
        )
        async with AsyncClient(transport=transport, base_url="http://test") as attacker:
            r = await attacker.post(
                f"/api/v1/shares/{token}/unlock",
                headers={"X-Forwarded-For": f"198.51.100.{attempt + 2}"},
                json={"password": "wrong"},
            )
        statuses.append(r.status_code)
        if r.status_code == 429:
            break
    assert statuses == [401] * 10 + [429]
