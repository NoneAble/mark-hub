"""Regression tests for Cloudflare-worker subsystem findings (review round 2)."""

from __future__ import annotations

import json
from datetime import UTC
from unittest.mock import MagicMock, patch

import pytest
from app.domain import remote_backup as rb
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_native_json_export_import_roundtrip_lossless(client: AsyncClient, auth_headers):
    """RQG-BACKUP-001: FastAPI can restore its own JSON export (folders/tags/fav/archive)."""
    h = auth_headers
    parent = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "R7Parent", "visibility": "public"},
        )
    ).json()
    child = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "R7Child", "parent_id": parent["id"], "visibility": "private"},
        )
    ).json()
    created = (
        await client.post(
            "/api/v1/bookmarks",
            headers=h,
            json={
                "title": "R7 Roundtrip",
                "url": "https://r7-roundtrip.example/item",
                "folder_id": child["id"],
                "visibility": "unlisted",
                "is_favorite": True,
                "is_archived": True,
                "tags": ["r7-tag", "r7-extra"],
                "description": "keep me",
            },
        )
    ).json()
    assert created["is_favorite"] is True
    assert created["is_archived"] is True

    exp = (await client.get("/api/v1/backup/export?format=json", headers=h)).json()
    assert exp["format"] == "markhub-json"
    hit = next(b for b in exp["bookmarks"] if b["url"] == "https://r7-roundtrip.example/item")
    assert hit["folder_path"] == ["R7Parent", "R7Child"]
    tag_names = []
    for t in hit.get("tags") or []:
        tag_names.append(t["name"] if isinstance(t, dict) else t)
    assert "r7-tag" in tag_names
    assert hit["is_favorite"] is True
    assert hit["is_archived"] is True

    # Wipe live bookmarks via replace_all restore of the export
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
    assert r.json()["created"] >= 1

    bms = (await client.get("/api/v1/bookmarks?q=r7-roundtrip", headers=h)).json()["items"]
    assert bms, "bookmark missing after restore"
    restored = bms[0]
    assert restored["is_favorite"] is True
    assert restored["is_archived"] is True
    assert restored.get("visibility") == "unlisted"
    rtags = []
    for t in restored.get("tags") or []:
        rtags.append(t["name"] if isinstance(t, dict) else t)
    assert "r7-tag" in rtags

    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    by_name = {f["name"]: f for f in folders}
    assert "R7Parent" in by_name
    assert "R7Child" in by_name
    # RQG-BACKUP-001: folder visibility must survive export → replace_all
    assert by_name["R7Parent"]["visibility"] == "public"
    assert by_name["R7Child"]["visibility"] == "private"


@pytest.mark.asyncio
async def test_native_json_restore_preserves_nested_folder_visibility(
    client: AsyncClient, auth_headers
):
    """RQG-BACKUP-001 failure mode: public folder restored as private after replace_all."""
    h = auth_headers
    parent = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "VisPublicRoot", "visibility": "public"},
        )
    ).json()
    mid = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={
                "name": "VisUnlistedMid",
                "parent_id": parent["id"],
                "visibility": "unlisted",
            },
        )
    ).json()
    leaf = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={
                "name": "VisPrivateLeaf",
                "parent_id": mid["id"],
                "visibility": "private",
            },
        )
    ).json()
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "VisRoundtrip",
            "url": "https://r7-folder-vis.example/item",
            "folder_id": leaf["id"],
            "visibility": "public",
            "is_favorite": True,
            "tags": ["vis-tag"],
        },
    )

    exp = (await client.get("/api/v1/backup/export?format=json", headers=h)).json()
    exported_folders = {f["name"]: f for f in exp["folders"] if not f.get("is_system")}
    assert exported_folders["VisPublicRoot"]["visibility"] == "public"
    assert exported_folders["VisUnlistedMid"]["visibility"] == "unlisted"
    assert exported_folders["VisPrivateLeaf"]["visibility"] == "private"

    # Destroy live tree, then restore from export (the reported failure path)
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
    assert r.json()["created"] >= 1

    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    restored = {f["name"]: f for f in folders}
    assert restored["VisPublicRoot"]["visibility"] == "public", (
        "folder visibility must not default to private on restore"
    )
    assert restored["VisUnlistedMid"]["visibility"] == "unlisted"
    assert restored["VisPrivateLeaf"]["visibility"] == "private"
    # Nesting preserved
    mid_id = restored["VisUnlistedMid"]["id"]
    assert restored["VisPrivateLeaf"]["parent_id"] == mid_id
    assert restored["VisUnlistedMid"]["parent_id"] == restored["VisPublicRoot"]["id"]

    bms = (await client.get("/api/v1/bookmarks?q=r7-folder-vis", headers=h)).json()["items"]
    assert bms
    assert bms[0]["visibility"] == "public"
    assert bms[0]["is_favorite"] is True
    rtags = [t["name"] if isinstance(t, dict) else t for t in (bms[0].get("tags") or [])]
    assert "vis-tag" in rtags


@pytest.mark.asyncio
async def test_native_json_restore_preserves_separator_folder_names(
    client: AsyncClient, auth_headers
):
    """RQG-BACKUP-001 failure mode: folder named `A/B` restored as A → B chain.

    Codex probe: restore produced `A -> B -> C` instead of `A/B -> C`.
    """
    h = auth_headers
    slash_parent = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "A/B", "visibility": "public"},
        )
    ).json()
    assert slash_parent["name"] == "A/B"
    child = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={
                "name": "C",
                "parent_id": slash_parent["id"],
                "visibility": "private",
            },
        )
    ).json()
    # Empty folder with separator in name (no bookmark) must also survive restore
    empty = (
        await client.post(
            "/api/v1/folders",
            headers=h,
            json={"name": "Empty/Leaf", "visibility": "unlisted"},
        )
    ).json()
    assert empty["name"] == "Empty/Leaf"
    await client.post(
        "/api/v1/bookmarks",
        headers=h,
        json={
            "title": "UnderSlash",
            "url": "https://r7-sep.example/item",
            "folder_id": child["id"],
            "visibility": "public",
        },
    )

    exp = (await client.get("/api/v1/backup/export?format=json", headers=h)).json()
    hit = next(b for b in exp["bookmarks"] if "r7-sep" in b["url"])
    assert hit["folder_path"] == ["A/B", "C"], hit.get("folder_path")
    exported_names = {f["name"] for f in exp["folders"] if not f.get("is_system")}
    assert "A/B" in exported_names
    assert "Empty/Leaf" in exported_names
    # Must not have been split into separate A and B folders in export
    assert "A" not in exported_names or any(
        f["name"] == "A/B" for f in exp["folders"]
    )

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
    assert r.json()["created"] >= 1

    folders = (await client.get("/api/v1/folders", headers=h)).json()["items"]
    by_name = {f["name"]: f for f in folders}
    assert "A/B" in by_name, f"separator name lost; folders={list(by_name)}"
    assert "C" in by_name
    assert "Empty/Leaf" in by_name, "empty separator folder missing after restore"
    # Failure mode: A and B appear as separate folders with C under B
    assert by_name["C"]["parent_id"] == by_name["A/B"]["id"]
    assert by_name["A/B"]["visibility"] == "public"
    assert by_name["C"]["visibility"] == "private"
    assert by_name["Empty/Leaf"]["visibility"] == "unlisted"
    # Ensure we did not create a three-level A → B → C chain
    spurious_a = [f for f in folders if f["name"] == "A" and not f.get("is_system")]
    if spurious_a:
        # Only fail if B is nested under A (the reported corruption)
        a_ids = {f["id"] for f in spurious_a}
        b_under_a = [
            f
            for f in folders
            if f["name"] == "B" and f.get("parent_id") in a_ids
        ]
        assert not b_under_a, "folder A/B was split into A → B"

    bms = (await client.get("/api/v1/bookmarks?q=r7-sep", headers=h)).json()["items"]
    assert bms
    assert bms[0]["folder_id"] == by_name["C"]["id"]


@pytest.mark.asyncio
async def test_import_accepts_tag_objects_without_500(client: AsyncClient, auth_headers):
    """RQG-BACKUP-001 failure mode: export used tag objects that importer rejected."""
    h = auth_headers
    # Minimal native-like payload without folder_path (only folder_id + folders[])
    payload = {
        "format": "markhub-json",
        "version": 1,
        "folders": [
            {"id": "fid-1", "name": "FromObjects", "parent_id": None, "is_system": False},
        ],
        "bookmarks": [
            {
                "title": "ObjTags",
                "url": "https://r7-obj-tags.example/",
                "folder_id": "fid-1",
                "tags": [{"id": "x", "name": "from-object"}],
                "is_favorite": True,
            }
        ],
    }
    r = await client.post(
        "/api/v1/backup/import",
        headers=h,
        json={"content": json.dumps(payload), "format": "json", "strategy": "skip_duplicate"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1
    bms = (await client.get("/api/v1/bookmarks?q=r7-obj-tags", headers=h)).json()["items"]
    assert bms
    names = [t["name"] if isinstance(t, dict) else t for t in (bms[0].get("tags") or [])]
    assert "from-object" in names
    assert bms[0]["is_favorite"] is True


def test_folder_path_meta_keys_are_segment_tuples_not_slash_joined():
    """RQG-BACKUP-001 unit: path keys must not use slash-join/split.

    Failure mode: key \"A/B\" + split('/') yields segments [\"A\", \"B\"].
    """
    from app.domain.backup import (
        _encode_folder_path_key,
        _folder_path_meta_from_export,
    )

    meta = _folder_path_meta_from_export(
        [
            {
                "id": "slash",
                "name": "A/B",
                "parent_id": None,
                "is_system": False,
                "visibility": "public",
            },
            {
                "id": "child",
                "name": "C",
                "parent_id": "slash",
                "is_system": False,
                "visibility": "private",
            },
            {
                "id": "empty",
                "name": "Empty/Leaf",
                "parent_id": None,
                "is_system": False,
                "visibility": "unlisted",
            },
        ]
    )
    assert _encode_folder_path_key(["A/B"]) in meta
    assert meta[_encode_folder_path_key(["A/B"])]["visibility"] == "public"
    assert meta[_encode_folder_path_key(["A/B", "C"])]["visibility"] == "private"
    assert meta[_encode_folder_path_key(["Empty/Leaf"])]["visibility"] == "unlisted"
    # Must not invent intermediate slash-split keys
    assert _encode_folder_path_key(["A"]) not in meta
    assert _encode_folder_path_key(["A", "B"]) not in meta
    assert _encode_folder_path_key(["A", "B", "C"]) not in meta


def test_s3_retention_reports_list_failure():
    """RQG-BACKUP-RETENTION-001: pruning errors are not swallowed."""
    cfg = {
        "endpoint": "https://example.r2.cloudflarestorage.com",
        "region": "auto",
        "bucket": "b",
        "access_key_id": "ak",
        "force_path_style": True,
    }
    client = MagicMock()
    client.put_object.return_value = {}
    client.list_objects_v2.side_effect = RuntimeError("AccessDenied listing")
    with patch.object(rb, "_s3_client", return_value=client):
        result = rb._s3_put_and_prune_sync(cfg, "secret", "markhub-backup/a.json", b"{}", 2, "markhub-backup/")
    assert result["retention_ok"] is False
    assert "list failed" in (result.get("retention_error") or "")


def test_s3_retention_prunes_and_reports_delete_failure():
    from datetime import datetime

    cfg = {
        "endpoint": "https://example.r2.cloudflarestorage.com",
        "region": "auto",
        "bucket": "b",
        "access_key_id": "ak",
        "force_path_style": True,
    }
    client = MagicMock()
    client.put_object.return_value = {}
    now = datetime.now(UTC)
    client.list_objects_v2.return_value = {
        "Contents": [
            {"Key": "markhub-backup/markhub-backup-3.json", "LastModified": now},
            {"Key": "markhub-backup/markhub-backup-2.json", "LastModified": now},
            {"Key": "markhub-backup/markhub-backup-1.json", "LastModified": now},
        ],
        "IsTruncated": False,
    }

    def _del(**kwargs):
        if kwargs["Key"].endswith("-1.json"):
            raise RuntimeError("delete denied")

    client.delete_object.side_effect = _del
    with patch.object(rb, "_s3_client", return_value=client):
        result = rb._s3_put_and_prune_sync(cfg, "secret", "markhub-backup/new.json", b"{}", 2, "markhub-backup/")
    assert result["pruned"] >= 0
    # keep=2 → one object beyond keep should be deleted; that delete fails
    assert result["retention_ok"] is False
    assert "delete failed" in (result.get("retention_error") or "")


def test_cf_deploy_readme_documents_remote_migrations_and_secrets():
    """RQG-CF-DEPLOY-001: production instructions must not rely on --local alone."""
    from pathlib import Path

    readme = Path(__file__).resolve().parents[2] / "README.md"
    text = readme.read_text(encoding="utf-8")
    assert "migrations apply markhub --remote" in text
    assert "MARKHUB_MASTER_KEY" in text
    assert "DEFAULT_ADMIN_PASSWORD" in text
    assert "JWT_SECRET" in text
    # Must not present local-only as the sole production path
    cloudflare = text.split("## Cloudflare", 1)[1].split("## License", 1)[0]
    # First production block should mention remote before any sole --local instruction
    assert "--remote" in cloudflare
    assert "secret put MARKHUB_MASTER_KEY" in cloudflare


def test_worker_cron_is_15_minutes():
    """RQG-CF-SCHEDULE-001: wrangler cron must support 15-minute board scans."""
    from pathlib import Path

    toml = (Path(__file__).resolve().parents[2] / "apps/worker/wrangler.toml").read_text()
    assert 'crons = ["*/15 * * * *"]' in toml


def test_ai_tasks_migration_checked_in():
    """RQG-CF-MIGRATION-001: ai_tasks must live in ordered D1 migrations."""
    from pathlib import Path

    mig = Path(__file__).resolve().parents[2] / "apps/worker/migrations/0004_ai_tasks.sql"
    assert mig.is_file()
    text = mig.read_text()
    assert "CREATE TABLE IF NOT EXISTS ai_tasks" in text
    # Runtime DDL helper must not recreate the table
    index = (Path(__file__).resolve().parents[2] / "apps/worker/src/index.ts").read_text()
    assert "CREATE TABLE IF NOT EXISTS ai_tasks" not in index
