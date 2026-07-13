"""Regression tests for Codex round-3/4 findings."""

from __future__ import annotations

import pytest
from app.database import async_session_maker
from app.domain import bookmarks as bm_svc
from app.models import Bookmark, OpLog, User
from httpx import AsyncClient
from sqlalchemy import func, select


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
async def test_ai_batch_domain_path_writes_oplog(client: AsyncClient, auth_headers):
    """F-009: bookmark AI field updates go through domain service + op_log."""
    bm = await client.post(
        "/api/v1/bookmarks",
        headers=auth_headers,
        json={"title": "Batch Me", "url": "https://batch.example/r4"},
    )
    assert bm.status_code == 200
    bid = bm.json()["id"]

    async with async_session_maker() as db:
        user = (await db.execute(select(User))).scalar_one()
        before = (
            await db.execute(
                select(func.count())
                .select_from(OpLog)
                .where(OpLog.entity_type == "bookmark", OpLog.entity_id == bid)
            )
        ).scalar_one()
        await bm_svc.update_bookmark(
            db,
            user.id,
            bid,
            {"ai_summary": "summary via domain", "ai_category": "General"},
        )
        await db.commit()
        after = (
            await db.execute(
                select(func.count())
                .select_from(OpLog)
                .where(OpLog.entity_type == "bookmark", OpLog.entity_id == bid)
            )
        ).scalar_one()
        assert after > before
        row = (
            await db.execute(select(Bookmark).where(Bookmark.id == bid))
        ).scalar_one()
        assert row.ai_summary == "summary via domain"
        assert row.ai_category == "General"


@pytest.mark.asyncio
async def test_openapi_paths_cover_core_collections():
    """F-010: checked-in contract should include collection CRUD paths."""
    from pathlib import Path

    text = Path(__file__).resolve().parents[2].joinpath("docs/openapi.yaml").read_text()
    for needle in (
        "/api/v1/bookmarks:",
        "/api/v1/folders:",
        "/api/v1/tags:",
        "/api/v1/boards:",
        "/api/v1/shares:",
        "/api/v1/settings:",
        "/api/v1/backup/s3:",
    ):
        assert needle in text, f"missing {needle}"
