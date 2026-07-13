"""Round 10 backup-and-restore regressions (RQG-F001/F003/F008).

Selected findings:
- RQG-F003: identity-preserving JSON/CSV/HTML round-trip fidelity
- RQG-F008: strict format/strategy/version validation before mutation
Worker atomicity (RQG-F001) is covered by apps/worker/scripts/test-restore-atomic.mjs
plus insert-first control flow in apps/worker/src/index.ts.
"""

from __future__ import annotations

import csv
import io
import json
import re

import pytest
from httpx import AsyncClient


def _folder_snapshot(folders: list[dict]) -> list[dict]:
    rows = []
    for f in folders:
        if f.get("is_system"):
            continue
        rows.append(
            {
                "name": f["name"],
                "visibility": f.get("visibility"),
                "sort_order": f.get("sort_order"),
                "parent_name": None,  # filled below
                "id": f["id"],
                "parent_id": f.get("parent_id"),
            }
        )
    by_id = {f["id"]: f for f in folders}
    for r in rows:
        pid = r["parent_id"]
        if pid and pid in by_id and not by_id[pid].get("is_system"):
            r["parent_name"] = by_id[pid]["name"]
        del r["id"]
        del r["parent_id"]
    return sorted(rows, key=lambda x: (x["parent_name"] or "", x["name"], x["sort_order"]))


def _bookmark_snapshot(items: list[dict], folders: list[dict]) -> list[dict]:
    by_id = {f["id"]: f for f in folders}
    out = []
    for b in items:
        tags = []
        for t in b.get("tags") or []:
            if isinstance(t, dict):
                tags.append(t.get("name"))
            else:
                tags.append(t)
        folder = by_id.get(b.get("folder_id") or "")
        out.append(
            {
                "title": b.get("title"),
                "url": b.get("url"),
                "visibility": b.get("visibility"),
                "is_favorite": bool(b.get("is_favorite")),
                "is_archived": bool(b.get("is_archived")),
                "sort_order": b.get("sort_order"),
                "folder_name": folder.get("name") if folder else None,
                "tags": sorted(tags),
            }
        )
    return sorted(out, key=lambda x: (x["url"], x["folder_name"] or "", x["title"]))


def _tag_snapshot(tags: list[dict]) -> list[dict]:
    return sorted(
        [{"name": t["name"], "color": t.get("color")} for t in tags],
        key=lambda x: x["name"],
    )


async def _full_dataset(client: AsyncClient, h: dict) -> dict:
    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    # unbounded list for export fidelity
    bms = (
        await client.get(
            "/api/v1/bookmarks?include_archived=true&limit=1000", headers=h
        )
    ).json()["items"]
    tags = (await client.get("/api/v1/tags", headers=h)).json()["items"]
    return {
        "folders": _folder_snapshot(folders),
        "bookmarks": _bookmark_snapshot(bms, folders),
        "tags": _tag_snapshot(tags),
    }


async def _seed_fidelity_dataset(client: AsyncClient, h: dict) -> dict:
    """Build a rich A dataset covering all RQG-F003 edge cases."""
    # Two same-parent same-name folders (identity must not collapse)
    d1 = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "DupName", "visibility": "public", "sort_order": 0},
        )
    ).json()
    d2 = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "DupName", "visibility": "private", "sort_order": 5},
        )
    ).json()
    assert d1["id"] != d2["id"]

    nested = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={
                "name": "Nested/Path",
                "parent_id": d1["id"],
                "visibility": "unlisted",
                "sort_order": 2,
            },
        )
    ).json()

    empty = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "EmptyOnly", "visibility": "public", "sort_order": 9},
        )
    ).json()
    assert empty["name"] == "EmptyOnly"

    # Unassociated tag with color
    lone = (
        await client.post(
            "/api/v1/tags",
            headers=h,
            json={"name": "orphan-tag", "color": "#ff00aa"},
        )
    ).json()
    assert lone["color"] == "#ff00aa"

    colored = (
        await client.post(
            "/api/v1/tags",
            headers=h,
            json={"name": "colored", "color": "#00ff88"},
        )
    ).json()

    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "In Dup Public",
            "url": "https://r10-fidelity.example/dup-public",
            "folder_id": d1["id"],
            "visibility": "public",
            "is_favorite": True,
            "is_archived": False,
            "sort_order": 3,
            "tags": ["colored", "shared"],
        },
    )
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "In Dup Private",
            "url": "https://r10-fidelity.example/dup-private",
            "folder_id": d2["id"],
            "visibility": "private",
            "is_favorite": False,
            "is_archived": True,
            "sort_order": 1,
            "tags": ["shared"],
        },
    )
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "Nested BM",
            "url": "https://r10-fidelity.example/nested",
            "folder_id": nested["id"],
            "visibility": "unlisted",
            "sort_order": 7,
            "tags": ["colored"],
        },
    )

    # Ensure colored tag color sticks
    tags = (await client.get("/api/v1/tags", headers=h)).json()["items"]
    by_name = {t["name"]: t for t in tags}
    if by_name.get("colored", {}).get("color") != "#00ff88":
        await client.patch(
            f"/api/v1/tags/{colored['id']}",
            headers=h,
            json={"color": "#00ff88"},
        )

    return await _full_dataset(client, h)


@pytest.mark.asyncio
async def test_json_clean_instance_roundtrip_preserves_identity(
    client: AsyncClient, auth_headers
):
    """RQG-F003: clean-instance A→B comparison for native JSON (Appendix D.2)."""
    h = auth_headers
    before = await _seed_fidelity_dataset(client, h)

    exp = (await client.get("/api/v1/backup/export?format=json", headers=h)).json()
    assert exp["format"] == "markhub-json"
    assert exp["version"] == 1
    # Export carries sort_order + root tags
    assert any(
        f.get("name") == "EmptyOnly" and not f.get("is_system") for f in exp["folders"]
    )
    assert any(t.get("name") == "orphan-tag" for t in exp["tags"])
    # Two DupName folders with distinct ids
    dups = [f for f in exp["folders"] if f.get("name") == "DupName" and not f.get("is_system")]
    assert len(dups) == 2
    assert {d["visibility"] for d in dups} == {"public", "private"}

    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": json.dumps(exp),
            "format": "json",
            "strategy": "replace_all",
            "confirm_replace": True,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] >= 3

    after = await _full_dataset(client, h)
    assert after["bookmarks"] == before["bookmarks"], (
        f"bookmark fidelity lost:\n before={before['bookmarks']}\n after={after['bookmarks']}"
    )
    assert after["folders"] == before["folders"], (
        f"folder fidelity lost:\n before={before['folders']}\n after={after['folders']}"
    )
    # Tag colors + unassociated tags
    assert after["tags"] == before["tags"], (
        f"tag fidelity lost:\n before={before['tags']}\n after={after['tags']}"
    )


@pytest.mark.asyncio
async def test_csv_roundtrip_preserves_nested_path_and_order(
    client: AsyncClient, auth_headers
):
    """RQG-F003: CSV export uses nested folder_path JSON; restore rebuilds hierarchy."""
    h = auth_headers
    parent = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "CsvRoot", "visibility": "public"},
        )
    ).json()
    child = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={
                "name": "CsvChild",
                "parent_id": parent["id"],
                "visibility": "unlisted",
            },
        )
    ).json()
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "CSV Nested",
            "url": "https://r10-csv.example/nested",
            "folder_id": child["id"],
            "visibility": "public",
            "is_favorite": True,
            "sort_order": 4,
            "tags": ["csv-tag"],
        },
    )

    csv_text = (
        await client.get("/api/v1/backup/export?format=csv", headers=h)
    ).text
    reader = csv.DictReader(io.StringIO(csv_text))
    rows = list(reader)
    hit = next(r for r in rows if "r10-csv" in (r.get("url") or ""))
    assert "folder_path" in hit
    path = json.loads(hit["folder_path"])
    assert path == ["CsvRoot", "CsvChild"], path
    assert "CsvRoot" in (hit.get("folder") or "")
    assert hit.get("sort_order") in ("4", 4, "4.0") or int(float(hit["sort_order"])) == 4

    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": csv_text,
            "format": "csv",
            "strategy": "replace_all",
            "confirm_replace": True,
        },
    )
    assert r.status_code == 200, r.text

    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    by_name = {f["name"]: f for f in folders if not f.get("is_system")}
    assert "CsvRoot" in by_name
    assert "CsvChild" in by_name
    assert by_name["CsvChild"]["parent_id"] == by_name["CsvRoot"]["id"]
    bms = (await client.get("/api/v1/bookmarks?q=r10-csv", headers=h)).json()["items"]
    assert bms
    assert bms[0]["folder_id"] == by_name["CsvChild"]["id"]
    assert bms[0]["is_favorite"] is True
    assert bms[0]["sort_order"] == 4


@pytest.mark.asyncio
async def test_html_roundtrip_preserves_visibility_and_tags(
    client: AsyncClient, auth_headers
):
    """RQG-F003: HTML export embeds DATA-VISIBILITY / TAGS; restore reads them back."""
    h = auth_headers
    folder = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "HtmlPublic", "visibility": "public"},
        )
    ).json()
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "HTML Item",
            "url": "https://r10-html.example/item",
            "folder_id": folder["id"],
            "visibility": "unlisted",
            "is_favorite": True,
            "is_archived": True,
            "sort_order": 2,
            "tags": ["html-tag", "extra"],
        },
    )

    html = (await client.get("/api/v1/backup/export?format=html", headers=h)).text
    assert "DATA-VISIBILITY" in html
    assert re.search(r'DATA-VISIBILITY="public"', html)
    assert re.search(r'TAGS="[^"]*html-tag', html)
    assert "DATA-FAVORITE" in html
    assert "DATA-SORT-ORDER" in html

    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": html,
            "format": "html",
            "strategy": "replace_all",
            "confirm_replace": True,
        },
    )
    assert r.status_code == 200, r.text

    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    by_name = {f["name"]: f for f in folders if not f.get("is_system")}
    assert by_name["HtmlPublic"]["visibility"] == "public"
    bms = (await client.get("/api/v1/bookmarks?q=r10-html", headers=h)).json()["items"]
    assert bms
    assert bms[0]["visibility"] == "unlisted"
    assert bms[0]["is_favorite"] is True
    assert bms[0]["is_archived"] is True
    rtags = [
        t["name"] if isinstance(t, dict) else t for t in (bms[0].get("tags") or [])
    ]
    assert "html-tag" in rtags


@pytest.mark.asyncio
async def test_import_rejects_unknown_strategy_before_mutation(
    client: AsyncClient, auth_headers
):
    """RQG-F008: unknown strategy must not mutate data."""
    h = auth_headers
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={"title": "Keep", "url": "https://r10-val.example/keep"},
    )
    before = (await client.get("/api/v1/bookmarks?q=r10-val", headers=h)).json()[
        "items"
    ]
    assert len(before) == 1

    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": "[]",
            "format": "json",
            "strategy": "explode_everything",
        },
    )
    # Pydantic enum or domain validation
    assert r.status_code in (400, 422), r.text

    after = (await client.get("/api/v1/bookmarks?q=r10-val", headers=h)).json()["items"]
    assert len(after) == 1
    assert after[0]["url"] == before[0]["url"]


@pytest.mark.asyncio
async def test_import_rejects_unknown_format(client: AsyncClient, auth_headers):
    """RQG-F008: unknown format rejected."""
    h = auth_headers
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={"content": "x", "format": "yaml", "strategy": "skip_duplicate"},
    )
    assert r.status_code in (400, 422), r.text


@pytest.mark.asyncio
async def test_import_rejects_unknown_native_version(
    client: AsyncClient, auth_headers
):
    """RQG-F008: unknown markhub-json version rejected before mutation."""
    h = auth_headers
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={"title": "VKeep", "url": "https://r10-ver.example/keep"},
    )
    payload = {
        "format": "markhub-json",
        "version": 99,
        "folders": [],
        "bookmarks": [
            {"title": "X", "url": "https://r10-ver.example/new"},
        ],
        "tags": [],
    }
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": json.dumps(payload),
            "format": "json",
            "strategy": "skip_duplicate",
        },
    )
    assert r.status_code == 400, r.text
    assert "version" in r.text.lower() or "unsupported" in r.text.lower()

    bms = (await client.get("/api/v1/bookmarks?q=r10-ver", headers=h)).json()["items"]
    assert len(bms) == 1
    assert bms[0]["url"] == "https://r10-ver.example/keep"


@pytest.mark.asyncio
async def test_import_rejects_partial_malformed_json(
    client: AsyncClient, auth_headers
):
    """RQG-F008: partial parser errors reject the whole payload (no partial write)."""
    h = auth_headers
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={"title": "Stay", "url": "https://r10-partial.example/stay"},
    )
    payload = {
        "format": "markhub-json",
        "version": 1,
        "folders": [{"id": "f1", "name": "Ok", "parent_id": None, "is_system": False}],
        "bookmarks": [
            {"title": "Good", "url": "https://r10-partial.example/good", "folder_id": "f1"},
            {"title": "Bad", "url": "", "folder_id": "f1"},  # missing url
        ],
        "tags": [],
    }
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": json.dumps(payload),
            "format": "json",
            "strategy": "skip_duplicate",
        },
    )
    assert r.status_code == 400, r.text
    assert "missing url" in r.text.lower() or "validation" in r.text.lower()

    bms = (await client.get("/api/v1/bookmarks?q=r10-partial", headers=h)).json()[
        "items"
    ]
    urls = {b["url"] for b in bms}
    assert "https://r10-partial.example/stay" in urls
    assert "https://r10-partial.example/good" not in urls


@pytest.mark.asyncio
async def test_import_rejects_malformed_csv_row(client: AsyncClient, auth_headers):
    """RQG-F008: CSV with a missing-url row is fully rejected."""
    h = auth_headers
    csv_body = "title,url,folder\nGood,https://r10-csvbad.example/g,A\nBad,,B\n"
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": csv_body,
            "format": "csv",
            "strategy": "skip_duplicate",
        },
    )
    assert r.status_code == 400, r.text
    bms = (await client.get("/api/v1/bookmarks?q=r10-csvbad", headers=h)).json()[
        "items"
    ]
    assert bms == []


@pytest.mark.asyncio
async def test_replace_all_without_confirm_is_rejected(
    client: AsyncClient, auth_headers
):
    """RQG-F008: replace_all requires confirm_replace."""
    h = auth_headers
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={
            "content": "[]",
            "format": "json",
            "strategy": "replace_all",
            "confirm_replace": False,
        },
    )
    assert r.status_code == 400, r.text
    assert "confirm" in r.text.lower()
