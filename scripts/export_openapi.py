#!/usr/bin/env python3
"""Export FastAPI OpenAPI schema to docs/openapi.yaml."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

os.environ.setdefault("JWT_SECRET", "export-openapi-jwt-secret-32ch")
os.environ.setdefault("MARKHUB_MASTER_KEY", "export-openapi-master-key-32ch")
os.environ.setdefault("DEFAULT_ADMIN_USERNAME", "admin")
os.environ.setdefault("DEFAULT_ADMIN_PASSWORD", "ExportPass12345")
os.environ.setdefault("FORCE_ADMIN_PASSWORD_CHANGE", "true")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:////tmp/markhub-openapi-export.db")

from app.main import app  # noqa: E402

try:
    import yaml
except ImportError:
    import subprocess

    subprocess.check_call([sys.executable, "-m", "pip", "install", "pyyaml", "-q"])
    import yaml  # type: ignore

schema = app.openapi()
out = {
    "openapi": schema.get("openapi", "3.0.3"),
    "info": {
        "title": "MarkHub API",
        "version": schema.get("info", {}).get("version", "0.1.0"),
        "description": (
            "Self-hosted bookmark hub — unified contract for Docker (FastAPI) "
            "and Cloudflare Workers. Error envelope: "
            '`{ "error": { "code", "message", "details?" } }`.'
        ),
    },
    "servers": [{"url": "/"}],
    "paths": schema.get("paths", {}),
    "components": schema.get("components", {}),
}
dest = ROOT / "docs" / "openapi.yaml"
with dest.open("w", encoding="utf-8") as f:
    yaml.dump(out, f, sort_keys=False, allow_unicode=True, default_flow_style=False)
print(f"wrote {dest} paths={len(out['paths'])} ops={sum(len(v) for v in out['paths'].values())}")
