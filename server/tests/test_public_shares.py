"""Public-access / sharing regressions (RQG-SHARE-001, RQG-SHARE-EXPIRY-001)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient


async def _inbox_id(client: AsyncClient, headers: dict) -> str:
    folders = (await client.get("/api/v1/folders", headers=headers)).json()["items"]
    return next(f for f in folders if f["is_system"])["id"]


@pytest.mark.asyncio
async def test_share_deleted_bookmark_not_exposed(client: AsyncClient, auth_headers):
    """RQG-SHARE-001: soft-deleted bookmark must not resolve via public share URL."""
    h = auth_headers
    inbox = await _inbox_id(client, h)
    secret_url = "https://deleted-share-target.example/private-path"

    bm = (
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={
                "title": "To Soft Delete",
                "url": secret_url,
                "folder_id": inbox,
                "visibility": "public",
            },
        )
    ).json()
    bm_id = bm["id"]

    share = (
        await client.post(
            "/api/v1/shares",
            headers=h,
            json={"target_type": "bookmark", "target_id": bm_id},
        )
    ).json()
    token = share["token"]

    live = await client.get(f"/api/v1/shares/{token}")
    assert live.status_code == 200, live.text
    assert live.json()["bookmark"]["url"] == secret_url

    deleted = await client.delete(f"/api/v1/bookmarks/{bm_id}", headers=h)
    assert deleted.status_code == 200, deleted.text

    after = await client.get(f"/api/v1/shares/{token}")
    assert after.status_code == 404, after.text
    body = after.json()
    assert body["error"]["code"] == "not_found"
    # Must not leak the soft-deleted URL/title in any success-shaped payload.
    assert secret_url not in after.text
    assert "bookmark" not in body or body.get("bookmark") is None


@pytest.mark.asyncio
async def test_share_expires_at_past_and_future(client: AsyncClient, auth_headers):
    """RQG-SHARE-EXPIRY-001: expires_at is persisted and enforced on resolve."""
    h = auth_headers
    inbox = await _inbox_id(client, h)
    bm = (
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={
                "title": "Expiring Share Target",
                "url": "https://expiry-share.example/item",
                "folder_id": inbox,
                "visibility": "public",
            },
        )
    ).json()

    past = (datetime.now(UTC) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    past_share = await client.post(
        "/api/v1/shares",
        headers=h,
        json={
            "target_type": "bookmark",
            "target_id": bm["id"],
            "expires_at": past,
        },
    )
    assert past_share.status_code == 200, past_share.text
    past_body = past_share.json()
    assert past_body.get("expires_at") is not None
    assert past_body["expires_at"] != "null"
    # Stored expiry must reflect a past timestamp (not silently dropped).
    assert past_body["expires_at"].startswith(past[:10])

    past_get = await client.get(f"/api/v1/shares/{past_body['token']}")
    assert past_get.status_code == 410, past_get.text
    assert past_get.json()["error"]["code"] == "expired"

    future = (datetime.now(UTC) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    future_share = await client.post(
        "/api/v1/shares",
        headers=h,
        json={
            "target_type": "bookmark",
            "target_id": bm["id"],
            "expires_at": future,
        },
    )
    assert future_share.status_code == 200, future_share.text
    future_body = future_share.json()
    assert future_body.get("expires_at") is not None
    assert future_body["expires_at"].startswith(future[:10])

    future_get = await client.get(f"/api/v1/shares/{future_body['token']}")
    assert future_get.status_code == 200, future_get.text
    assert future_get.json()["bookmark"]["url"] == "https://expiry-share.example/item"

    listed = await client.get("/api/v1/shares", headers=h)
    assert listed.status_code == 200
    by_token = {item["token"]: item for item in listed.json()["items"]}
    assert by_token[future_body["token"]].get("expires_at") is not None
