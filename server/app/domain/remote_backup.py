from __future__ import annotations

import asyncio
import json
import time

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.backup import export_json
from app.domain.settings_svc import get_json_setting, get_setting, set_json_setting, set_setting
from app.utils.errors import api_error
from app.utils.s3_validate import normalize_s3_prefix, validate_s3_config
from app.utils.timeutil import server_now

# ─── WebDAV ───────────────────────────────────────────────

async def get_webdav_config(db: AsyncSession, user_id: str) -> dict:
    cfg = await get_json_setting(db, user_id, "webdav_config", {}) or {}
    password_set = bool(await get_setting(db, user_id, "webdav_password", ""))
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "url": cfg.get("url") or "",
        "username": cfg.get("username") or "",
        "password_set": password_set,
        "path": cfg.get("path") or "markhub-backup/",
        "keep_backups": int(cfg.get("keep_backups") or 7),
        "backup_time": cfg.get("backup_time") or "02:00",
        "last_backup_at": cfg.get("last_backup_at"),
    }


async def save_webdav_config(db: AsyncSession, user_id: str, data: dict) -> dict:
    cfg = await get_json_setting(db, user_id, "webdav_config", {}) or {}
    for k in ("enabled", "url", "username", "path", "keep_backups", "backup_time"):
        if k in data and data[k] is not None:
            cfg[k] = data[k]
    if data.get("password"):
        await set_setting(db, user_id, "webdav_password", str(data["password"]), is_secret=True)
    await set_json_setting(db, user_id, "webdav_config", cfg)
    return await get_webdav_config(db, user_id)


def _webdav_list_sync(url: str, username: str, password: str) -> None:
    from webdav3.client import Client

    client = Client(
        {
            "webdav_hostname": url,
            "webdav_login": username,
            "webdav_password": password,
        }
    )
    client.list()


async def test_webdav(db: AsyncSession, user_id: str) -> dict:
    cfg = await get_webdav_config(db, user_id)
    if not cfg["url"]:
        return {"ok": False, "code": "webdav_config", "message": "url required"}
    password = await get_setting(db, user_id, "webdav_password", "")
    t0 = time.time()
    try:
        await asyncio.wait_for(
            asyncio.to_thread(_webdav_list_sync, cfg["url"], cfg["username"], password),
            timeout=10.0,
        )
        return {
            "ok": True,
            "latency_ms": int((time.time() - t0) * 1000),
            "endpoint_reachable": True,
        }
    except Exception as e:
        return {
            "ok": False,
            "code": "webdav_error",
            "message": str(e)[:200],
            "latency_ms": int((time.time() - t0) * 1000),
        }


def _webdav_upload_and_prune_sync(
    url: str, username: str, password: str, path: str, body: str, keep: int, prefix: str
) -> dict:
    """Upload then prune. Returns retention status (RQG-BACKUP-RETENTION-001)."""
    import os
    import tempfile

    from webdav3.client import Client

    client = Client(
        {
            "webdav_hostname": url,
            "webdav_login": username,
            "webdav_password": password,
        }
    )
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        f.write(body)
        tmp = f.name
    try:
        client.upload_sync(remote_path=path, local_path=tmp)
    finally:
        os.unlink(tmp)

    pruned = 0
    retention_ok = True
    retention_error: str | None = None
    try:
        listing = client.list(prefix)
        files = sorted(
            [
                x
                for x in listing
                if isinstance(x, str) and "markhub-backup-" in x and x.endswith(".json")
            ],
            reverse=True,
        )
        for old in files[keep:]:
            try:
                remote = old if old.startswith(prefix) else prefix + old.lstrip("/")
                client.clean(remote)
                pruned += 1
            except Exception as e:
                retention_ok = False
                retention_error = f"delete failed: {str(e)[:120]}"
    except Exception as e:
        retention_ok = False
        retention_error = f"list failed: {str(e)[:120]}"
    return {
        "pruned": pruned,
        "retention_ok": retention_ok,
        "retention_error": retention_error,
    }


async def run_webdav_backup(db: AsyncSession, user_id: str) -> dict:
    cfg = await get_json_setting(db, user_id, "webdav_config", {}) or {}
    password = await get_setting(db, user_id, "webdav_password", "")
    if not cfg.get("url"):
        raise api_error("webdav_config", "WebDAV not configured")
    data = await export_json(db, user_id)
    body = json.dumps(data, ensure_ascii=False, indent=2)
    stamp = server_now().strftime("%Y-%m-%d-%H-%M-%S")
    path = (cfg.get("path") or "markhub-backup/").rstrip("/") + f"/markhub-backup-{stamp}.json"
    keep = int(cfg.get("keep_backups") or 7)
    prefix = (cfg.get("path") or "markhub-backup/").rstrip("/") + "/"
    try:
        retention = await asyncio.wait_for(
            asyncio.to_thread(
                _webdav_upload_and_prune_sync,
                cfg["url"],
                cfg.get("username") or "",
                password,
                path,
                body,
                keep,
                prefix,
            ),
            timeout=60.0,
        )
        cfg["last_backup_at"] = server_now().isoformat() + "Z"
        if not retention.get("retention_ok", True):
            cfg["last_retention_error"] = retention.get("retention_error")
        else:
            cfg.pop("last_retention_error", None)
        await set_json_setting(db, user_id, "webdav_config", cfg)
        return {
            "ok": True,
            "path": path,
            "retention_ok": retention.get("retention_ok", True),
            "retention_error": retention.get("retention_error"),
            "pruned": retention.get("pruned", 0),
        }
    except Exception as e:
        raise api_error("webdav_backup_failed", str(e)[:300])


# ─── S3 / R2 ──────────────────────────────────────────────

async def get_s3_config(db: AsyncSession, user_id: str) -> dict:
    cfg = await get_json_setting(db, user_id, "s3_config", {}) or {}
    secret_set = bool(await get_setting(db, user_id, "s3_secret_access_key", ""))
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "endpoint": cfg.get("endpoint") or "",
        "region": cfg.get("region") or "auto",
        "bucket": cfg.get("bucket") or "",
        "key_prefix": cfg.get("key_prefix") or "markhub-backup/",
        "access_key_id": cfg.get("access_key_id") or "",
        "secret_set": secret_set,
        "keep_backups": int(cfg.get("keep_backups") or 7),
        "backup_time": cfg.get("backup_time") or "02:00",
        "force_path_style": cfg.get("force_path_style", True),
        "last_backup_at": cfg.get("last_backup_at"),
        "last_backup_key": cfg.get("last_backup_key"),
    }


async def save_s3_config(db: AsyncSession, user_id: str, data: dict) -> dict:
    """Persist S3/R2 backup config with Appendix B validation (F-003)."""
    cfg = await get_json_setting(db, user_id, "s3_config", {}) or {}
    merged = dict(cfg)
    for k in (
        "enabled",
        "endpoint",
        "region",
        "bucket",
        "access_key_id",
        "keep_backups",
        "backup_time",
        "force_path_style",
    ):
        if k in data and data[k] is not None:
            merged[k] = data[k]
    if "key_prefix" in data and data["key_prefix"] is not None:
        merged["key_prefix"] = normalize_s3_prefix(str(data["key_prefix"]))

    secret_already = bool(await get_setting(db, user_id, "s3_secret_access_key", ""))
    candidate = {
        "endpoint": merged.get("endpoint") or "",
        "region": merged.get("region") or "auto",
        "bucket": merged.get("bucket") or "",
        "key_prefix": merged.get("key_prefix") or "markhub-backup/",
        "access_key_id": merged.get("access_key_id") or "",
        "secret_access_key": data.get("secret_access_key") or "",
        "keep_backups": merged.get("keep_backups", 7),
        "backup_time": merged.get("backup_time") or "02:00",
        "enabled": bool(merged.get("enabled", False)),
    }

    # Always validate format of any non-empty / provided fields (invalid URL, 99:99, keep=0, etc.)
    format_probe = {
        "endpoint": candidate["endpoint"] or "https://placeholder.example.com",
        "region": candidate["region"] or "auto",
        "bucket": candidate["bucket"] or "placeholder-bucket",
        "access_key_id": candidate["access_key_id"] or "placeholder",
        "secret_access_key": candidate["secret_access_key"] or "placeholder",
        "keep_backups": candidate["keep_backups"],
        "backup_time": candidate["backup_time"],
    }
    # Override with actual values that were supplied so invalid ones fail
    for field in ("endpoint", "bucket", "region", "keep_backups", "backup_time"):
        if field in data and data[field] is not None:
            format_probe[field] = data[field]
        elif candidate.get(field) not in (None, ""):
            format_probe[field] = candidate[field]

    format_errors = validate_s3_config(
        format_probe, require_secrets=False, secret_already_set=True
    )
    # Drop errors for fields that are still empty placeholders (not yet configured)
    filtered: list[str] = []
    for e in format_errors:
        if "endpoint" in e and not (data.get("endpoint") or candidate["endpoint"]):
            continue
        if "bucket" in e and not (data.get("bucket") or candidate["bucket"]):
            continue
        filtered.append(e)
    if filtered:
        raise api_error("validation", "; ".join(filtered))

    if candidate["enabled"]:
        enable_errors = validate_s3_config(
            candidate,
            require_secrets=True,
            secret_already_set=secret_already,
        )
        if enable_errors:
            raise api_error("validation", "; ".join(enable_errors))

    for k in (
        "enabled",
        "endpoint",
        "region",
        "bucket",
        "access_key_id",
        "keep_backups",
        "backup_time",
        "force_path_style",
    ):
        if k in data and data[k] is not None:
            cfg[k] = data[k]
    if "key_prefix" in data and data["key_prefix"] is not None:
        cfg["key_prefix"] = normalize_s3_prefix(str(data["key_prefix"]))
    if data.get("secret_access_key"):
        await set_setting(
            db, user_id, "s3_secret_access_key", str(data["secret_access_key"]), is_secret=True
        )
    await set_json_setting(db, user_id, "s3_config", cfg)
    return await get_s3_config(db, user_id)


def _s3_client(cfg: dict, secret: str):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=cfg.get("endpoint") or None,
        region_name=cfg.get("region") or "auto",
        aws_access_key_id=cfg.get("access_key_id") or "",
        aws_secret_access_key=secret,
        config=Config(
            s3={"addressing_style": "path" if cfg.get("force_path_style", True) else "auto"},
            connect_timeout=10,
            read_timeout=10,
            retries={"max_attempts": 2},
        ),
    )


def _s3_list_sync(cfg: dict, secret: str) -> None:
    client = _s3_client(cfg, secret)
    client.list_objects_v2(Bucket=cfg["bucket"], MaxKeys=1)


def _s3_put_and_prune_sync(
    cfg: dict, secret: str, key: str, body: bytes, keep: int, prefix: str
) -> dict:
    """Upload then prune with paginated listing; report retention failures."""
    client = _s3_client(cfg, secret)
    client.put_object(Bucket=cfg["bucket"], Key=key, Body=body, ContentType="application/json")
    pruned = 0
    retention_ok = True
    retention_error: str | None = None
    try:
        objs: list[dict] = []
        token = None
        while True:
            kwargs: dict = {
                "Bucket": cfg["bucket"],
                "Prefix": prefix,
                "MaxKeys": 1000,
            }
            if token:
                kwargs["ContinuationToken"] = token
            listed = client.list_objects_v2(**kwargs)
            objs.extend(listed.get("Contents") or [])
            if not listed.get("IsTruncated"):
                break
            token = listed.get("NextContinuationToken")
            if not token:
                break
        objs = [
            o
            for o in objs
            if "markhub-backup-" in o.get("Key", "") and o.get("Key", "").endswith(".json")
        ]
        objs = sorted(objs, key=lambda o: o["LastModified"], reverse=True)
        for old in objs[keep:]:
            try:
                client.delete_object(Bucket=cfg["bucket"], Key=old["Key"])
                pruned += 1
            except Exception as e:
                retention_ok = False
                retention_error = f"delete failed: {str(e)[:120]}"
    except Exception as e:
        retention_ok = False
        retention_error = f"list failed: {str(e)[:120]}"
    return {
        "pruned": pruned,
        "retention_ok": retention_ok,
        "retention_error": retention_error,
    }


async def test_s3(db: AsyncSession, user_id: str) -> dict:
    cfg = await get_json_setting(db, user_id, "s3_config", {}) or {}
    secret = await get_setting(db, user_id, "s3_secret_access_key", "")
    if not cfg.get("endpoint") or not cfg.get("bucket"):
        return {"ok": False, "code": "s3_config", "message": "endpoint and bucket required"}
    t0 = time.time()
    try:
        await asyncio.wait_for(asyncio.to_thread(_s3_list_sync, cfg, secret), timeout=10.0)
        return {
            "ok": True,
            "latency_ms": int((time.time() - t0) * 1000),
            "endpoint_reachable": True,
        }
    except Exception as e:
        msg = str(e)
        code = "s3_network"
        low = msg.lower()
        if "403" in msg or "access denied" in low or "invalidaccesskey" in low:
            code = "s3_auth" if "invalid" in low or "signature" in low else "s3_forbidden"
        elif "404" in msg or "nosuchbucket" in low:
            code = "s3_not_found"
        return {
            "ok": False,
            "code": code,
            "message": msg[:200],
            "latency_ms": int((time.time() - t0) * 1000),
        }


async def run_s3_backup(db: AsyncSession, user_id: str) -> dict:
    cfg = await get_json_setting(db, user_id, "s3_config", {}) or {}
    secret = await get_setting(db, user_id, "s3_secret_access_key", "")
    if not cfg.get("endpoint") or not cfg.get("bucket"):
        raise api_error("s3_config", "S3 not configured")
    data = await export_json(db, user_id)
    body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    prefix = normalize_s3_prefix(cfg.get("key_prefix") or "markhub-backup/")
    stamp = server_now().strftime("%Y-%m-%d-%H-%M-%S")
    key = f"{prefix}markhub-backup-{stamp}.json"
    keep = int(cfg.get("keep_backups") or 7)
    try:
        retention = await asyncio.wait_for(
            asyncio.to_thread(_s3_put_and_prune_sync, cfg, secret, key, body, keep, prefix),
            timeout=60.0,
        )
        cfg["last_backup_at"] = server_now().isoformat() + "Z"
        cfg["last_backup_key"] = key
        if not retention.get("retention_ok", True):
            cfg["last_retention_error"] = retention.get("retention_error")
        else:
            cfg.pop("last_retention_error", None)
        await set_json_setting(db, user_id, "s3_config", cfg)
        return {
            "ok": True,
            "key": key,
            "retention_ok": retention.get("retention_ok", True),
            "retention_error": retention.get("retention_error"),
            "pruned": retention.get("pruned", 0),
        }
    except Exception as e:
        raise api_error("s3_backup_failed", str(e)[:300])
