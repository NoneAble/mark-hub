"""S3 Appendix B validation — shared Python port of packages/core s3Config."""
from __future__ import annotations

import re
from urllib.parse import urlparse

_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", re.I)
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def normalize_s3_prefix(prefix: str) -> str:
    p = (prefix or "").lstrip("/")
    if p and not p.endswith("/"):
        p += "/"
    return p


def validate_s3_config(data: dict, *, require_secrets: bool = True, secret_already_set: bool = False) -> list[str]:
    errors: list[str] = []
    endpoint = (data.get("endpoint") or "").strip()
    if not endpoint:
        errors.append("endpoint is required")
    else:
        try:
            u = urlparse(endpoint)
            if u.scheme not in ("http", "https") or not u.netloc:
                errors.append("endpoint must be a valid http(s) URL")
        except Exception:
            errors.append("endpoint must be a valid URL")

    bucket = (data.get("bucket") or "").strip()
    if not bucket:
        errors.append("bucket is required")
    elif not _BUCKET_RE.match(bucket):
        errors.append("bucket name is invalid")

    region = (data.get("region") or "").strip()
    if not region:
        errors.append("region is required")

    keep = data.get("keep_backups", 7)
    try:
        keep_n = int(keep)
        if keep_n < 1:
            errors.append("keep_backups must be >= 1")
    except (TypeError, ValueError):
        errors.append("keep_backups must be >= 1")

    backup_time = (data.get("backup_time") or "02:00").strip()
    if not _TIME_RE.match(backup_time):
        errors.append("backup_time must be HH:mm")

    access_key_id = (data.get("access_key_id") or "").strip()
    secret = data.get("secret_access_key") or ""
    if require_secrets:
        if not access_key_id:
            errors.append("access_key_id is required")
        if not secret and not secret_already_set:
            errors.append("secret_access_key is required")

    return errors
