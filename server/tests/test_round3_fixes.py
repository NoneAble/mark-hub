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
