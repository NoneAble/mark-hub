"""Regression tests for Codex round-3/4 findings."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_folder_delete_rejects_unknown_mode(client: AsyncClient, auth_headers):
    f = await client.post(
        "/api/v1/folders",
        headers=auth_headers,
        json={"name": "Do Not Typo Delete"},
    )
    assert f.status_code == 200
    fid = f.json()["id"]
    r = await client.delete(
        f"/api/v1/folders/{fid}",
        headers=auth_headers,
        params={"mode": "typo_mode"},
    )
    assert r.status_code in (400, 422)
    listed = await client.get("/api/v1/folders", headers=auth_headers)
    ids = [x["id"] for x in listed.json()["items"]]
    assert fid in ids


@pytest.mark.asyncio
async def test_openapi_paths_cover_core_collections():
    """F-010: checked-in contract should include collection CRUD paths."""
    from pathlib import Path

    text = Path(__file__).resolve().parents[2].joinpath("docs/openapi.yaml").read_text()
    for needle in (
        "/api/v1/bookmarks:",
        "/api/v1/folders:",
        "/api/v1/tags:",
        "/api/v1/backup/s3:",
    ):
        assert needle in text, f"missing {needle}"
