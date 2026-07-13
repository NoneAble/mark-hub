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
async def test_board_scan_writes_annotation_ops(client: AsyncClient, auth_headers):
    """F006: full scan and group reorder appear in /changes."""
    h = auth_headers
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={"title": "ScanMe", "url": "https://scan-r6.example/", "folder_id": inbox["id"]},
    )
    board = (
        await client.post(
            "/api/v1/boards",
            headers=h,
            json={"name": "Scan Board", "type": "ai_channels", "source_folder_ids": [inbox["id"]]},
        )
    ).json()
    scan = await client.post(
        f"/api/v1/boards/{board['id']}/scan", headers=h, json={"mode": "full"}
    )
    assert scan.status_code == 200, scan.text
    g1 = (
        await client.post(
            f"/api/v1/boards/{board['id']}/groups",
            headers=h,
            json={"name": "G1", "keywords": ["scan"]},
        )
    ).json()
    g2 = (
        await client.post(
            f"/api/v1/boards/{board['id']}/groups",
            headers=h,
            json={"name": "G2", "keywords": []},
        )
    ).json()
    re = await client.post(
        f"/api/v1/boards/{board['id']}/groups/reorder",
        headers=h,
        json={"ordered_ids": [g2["id"], g1["id"]]},
    )
    assert re.status_code == 200, re.text
    changes = (await client.get("/api/v1/changes?limit=200", headers=h)).json()
    items = changes.get("items") or changes.get("changes") or changes
    if isinstance(items, dict):
        items = items.get("items") or []
    actions = {(c.get("entity_type"), c.get("action")) for c in items}
    assert "annotation" in {a[0] for a in actions}, f"expected annotation ops, got {actions}"
    assert any(a[0] == "reorder" for a in actions), f"expected reorder op, got {actions}"


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
async def test_mcp_call_system_folder_guard(client: AsyncClient, auth_headers):
    """F004/F010: MCP call rejects reparenting system folder (Docker)."""
    h = auth_headers
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    other = (
        await client.post("/api/v1/folders", headers=h, json={"name": "NormalR6"})
    ).json()
    # JWT is accepted by /mcp/call auth (SPA parity)
    r = await client.post(
        "/api/v1/mcp/call",
        headers=h,
        json={
            "name": "reorder_markhub_folders",
            "arguments": {
                "ordered_ids": [inbox["id"]],
                "parent_id": other["id"],
            },
        },
    )
    # Domain service must refuse reparent of system folder
    if r.status_code == 200:
        folders2 = (await client.get("/api/v1/folders", headers=h)).json()["items"]
        inbox2 = next(f for f in folders2 if f["id"] == inbox["id"])
        assert inbox2.get("parent_id") != other["id"]
    else:
        assert r.status_code in (400, 403, 422)


@pytest.mark.asyncio
async def test_ai_quick_add_canonical_paths_exist(client: AsyncClient, auth_headers):
    """F003 paths exist on FastAPI (Worker aligned separately)."""
    h = auth_headers
    for path in (
        "/api/v1/ai/quick-add",
        "/api/v1/ai/quick-add/with-title",
        "/api/v1/ai/quick-add/with-category",
    ):
        r = await client.post(path, headers=h, json={"url": "https://qa-r6.example/"})
        assert r.status_code != 404, f"{path} missing"


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


@pytest.mark.asyncio
async def test_board_source_update_triggers_scan(client: AsyncClient, auth_headers):
    """F020: changing board sources runs a scan (annotations appear)."""
    h = auth_headers
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    inbox = next(f for f in folders if f["is_system"])
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={"title": "Src", "url": "https://src-scan-r6.example/", "folder_id": inbox["id"]},
    )
    board = (
        await client.post(
            "/api/v1/boards",
            headers=h,
            json={"name": "Src Board", "type": "ai_channels", "source_folder_ids": []},
        )
    ).json()
    await client.patch(
        f"/api/v1/boards/{board['id']}",
        headers=h,
        json={"source_folder_ids": [inbox["id"]]},
    )
    anns = (
        await client.get(f"/api/v1/boards/{board['id']}/annotations", headers=h)
    ).json()["items"]
    assert len(anns) >= 1
