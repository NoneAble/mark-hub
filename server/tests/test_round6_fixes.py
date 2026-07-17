"""Regression tests for Codex round-6 findings (F001–F021 subset, Docker runtime)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from app.database import async_session_maker
from app.models import Bookmark
from app.utils.timeutil import server_now
from httpx import AsyncClient
from sqlalchemy import select


@pytest.mark.asyncio
async def test_bookmark_list_includes_tags(client: AsyncClient, auth_headers):
    """F016 (Docker parity): list must return tags; edit without tags preserves them."""
    h = auth_headers
    bm = (
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={
                "title": "Tagged",
                "url": "https://tags-r6.example/",
                "tags": ["keep-me", "alpha"],
            },
        )
    ).json()
    assert any(t["name"] == "keep-me" for t in bm.get("tags") or [])
    listed = (await client.get("/api/v1/bookmarks?limit=50", headers=h)).json()
    hit = next(x for x in listed["items"] if x["id"] == bm["id"])
    names = {t["name"] if isinstance(t, dict) else t for t in hit.get("tags") or []}
    assert "keep-me" in names
    patched = (
        await client.patch(
            f"/api/v1/bookmarks/{bm['id']}",
            headers=h,
            json={"title": "Tagged v2"},
        )
    ).json()
    names2 = {t["name"] if isinstance(t, dict) else t for t in patched.get("tags") or []}
    assert "keep-me" in names2


@pytest.mark.asyncio
async def test_soft_delete_gc_purges_old_rows(client: AsyncClient, auth_headers):
    """F005: GC removes bookmarks soft-deleted > 30 days ago."""
    h = auth_headers
    bm = (
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={"title": "OldTrash", "url": "https://gc-r6.example/"},
        )
    ).json()
    await client.delete(f"/api/v1/bookmarks/{bm['id']}", headers=h)
    async with async_session_maker() as db:
        row = (await db.execute(select(Bookmark).where(Bookmark.id == bm["id"]))).scalar_one()
        row.deleted_at = server_now() - timedelta(days=31)
        await db.commit()

    from app.jobs.scheduler import run_soft_delete_gc

    result = await run_soft_delete_gc()
    assert result["bookmarks"] >= 1
    async with async_session_maker() as db:
        gone = (
            await db.execute(select(Bookmark).where(Bookmark.id == bm["id"]))
        ).scalar_one_or_none()
        assert gone is None


@pytest.mark.asyncio
async def test_import_html_creates_folder_path(client: AsyncClient, auth_headers):
    """F007 (Docker): Netscape import reconstructs folders."""
    h = auth_headers
    html = """<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>ParentR6</H3>
<DL><p>
<DT><H3>ChildR6</H3>
<DL><p>
<DT><A HREF="https://nested-r6.example/">Nested Link</A>
</DL><p>
</DL><p>
</DL><p>
"""
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={"content": html, "format": "html", "strategy": "skip_duplicate"},
    )
    assert r.status_code == 200, r.text
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    names = {f["name"] for f in folders}
    assert "ParentR6" in names
    assert "ChildR6" in names
    bms = (await client.get("/api/v1/bookmarks?q=nested-r6", headers=h)).json()["items"]
    assert any("nested-r6" in b["url"] for b in bms)


@pytest.mark.asyncio
async def test_export_json_includes_bookmark_tags(client: AsyncClient, auth_headers):
    """F007: JSON export preserves tag associations."""
    h = auth_headers
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "ExportTag",
            "url": "https://export-tag-r6.example/",
            "tags": ["export-tag"],
        },
    )
    exp = (await client.get("/api/v1/backup/export?format=json", headers=h)).json()
    hit = next(b for b in exp["bookmarks"] if "export-tag-r6" in b["url"])
    tag_names = []
    for t in hit.get("tags") or []:
        tag_names.append(t["name"] if isinstance(t, dict) else t)
    assert "export-tag" in tag_names


@pytest.mark.asyncio
async def test_search_batch_tags_perf_smoke(client: AsyncClient, auth_headers):
    """F015 smoke: listing many bookmarks does not explode (batch tags)."""
    h = auth_headers
    for i in range(30):
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={
                "title": f"Perf {i}",
                "url": f"https://perf-r6.example/{i}",
                "tags": [f"t{i % 5}", "shared"],
            },
        )
    import time

    t0 = time.perf_counter()
    r = await client.get("/api/v1/bookmarks?q=shared&limit=50", headers=h)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert r.status_code == 200
    assert elapsed_ms < 2000
    items = r.json()["items"]
    assert all("tags" in it for it in items)
