"""Shared dual-runtime conformance fixtures (PR-26 / F-010 / R4-F003).

These cases are executed against FastAPI in unit tests and can be pointed at a
live Worker+D1 base URL via:

  MARKHUB_PARITY_BASE_URL=http://127.0.0.1:18102 pytest server/tests/test_parity_live.py

Credentials come from the environment so secure deployments (non-default admin
passwords) can run the same suite.
"""

from __future__ import annotations

import os

# Prefer env-provided credentials (production-safe). Tests set admin/admin123.
PARITY_USERNAME = os.environ.get("MARKHUB_ADMIN_USERNAME", "admin")
PARITY_PASSWORD = os.environ.get(
    "MARKHUB_ADMIN_PASSWORD",
    os.environ.get("DEFAULT_ADMIN_PASSWORD", "admin123"),
)

# Stateless status checks + a few schema shape assertions used by both runtimes.
PARITY_CASES: list[dict] = [
    {"id": "health", "method": "GET", "path": "/api/v1/health", "auth": False, "status": 200},
    {"id": "version", "method": "GET", "path": "/api/v1/version", "auth": False, "status": 200},
    {
        "id": "metrics",
        "method": "GET",
        "path": "/api/v1/metrics",
        "auth": False,
        "status": 200,
        "json_keys": ["requests_total", "errors_5xx"],
    },
    {
        "id": "login_ok",
        "method": "POST",
        "path": "/api/v1/auth/login",
        "auth": False,
        "json": {"username": PARITY_USERNAME, "password": PARITY_PASSWORD},
        "status": 200,
        "json_keys": ["access_token"],
    },
    {
        "id": "nav_public",
        "method": "GET",
        "path": "/api/v1/nav/public",
        "auth": False,
        "status": 200,
    },
    {
        "id": "folders_list",
        "method": "GET",
        "path": "/api/v1/folders",
        "auth": True,
        "status": 200,
        "json_keys": ["items"],
    },
    {
        "id": "bookmarks_list",
        "method": "GET",
        "path": "/api/v1/bookmarks?limit=5&offset=0",
        "auth": True,
        "status": 200,
        "json_keys": ["items", "total", "limit", "offset"],
    },
    {
        "id": "tags_list",
        "method": "GET",
        "path": "/api/v1/tags",
        "auth": True,
        "status": 200,
        "json_keys": ["items"],
    },
    {
        "id": "s3_get",
        "method": "GET",
        "path": "/api/v1/backup/s3",
        "auth": True,
        "status": 200,
    },
    {
        "id": "webdav_get",
        "method": "GET",
        "path": "/api/v1/backup/webdav",
        "auth": True,
        "status": 200,
    },
    {
        "id": "changes",
        "method": "GET",
        "path": "/api/v1/changes?since=0&limit=10",
        "auth": True,
        "status": 200,
        "json_keys": ["changes", "next_cursor"],
    },
]


# Stateful sequence exercised identically against both runtimes (R4-F003).
PARITY_STATEFUL_STEPS: list[dict] = [
    {
        "id": "folder_create",
        "method": "POST",
        "path": "/api/v1/folders",
        "json": {"name": "Parity Folder", "visibility": "private"},
        "status": 200,
        "save": {"folder_id": "id"},
    },
    {
        "id": "bookmark_create",
        "method": "POST",
        "path": "/api/v1/bookmarks",
        "json_from": {
            "title": "Parity BM",
            "url": "https://parity.example/item",
            "folder_id": "$folder_id",
            "visibility": "private",
            "tags": ["parity"],
        },
        "status": 200,
        "save": {"bookmark_id": "id"},
    },
    {
        "id": "bookmark_batch_move",
        "method": "POST",
        "path": "/api/v1/bookmarks/batch",
        "json_from": {
            "action": "move",
            "ids": ["$bookmark_id"],
            "payload": {"folder_id": "$folder_id"},
        },
        "status": 200,
    },
    {
        "id": "bookmark_page",
        "method": "GET",
        "path": "/api/v1/bookmarks?limit=1&offset=0",
        "status": 200,
        "json_keys": ["items", "total", "limit", "offset"],
    },
    {
        "id": "folder_cycle_reject",
        "method": "PATCH",
        "path_from": "/api/v1/folders/$folder_id",
        "json_from": {"parent_id": "$folder_id"},
        "status_in": [400, 422],
    },
]
