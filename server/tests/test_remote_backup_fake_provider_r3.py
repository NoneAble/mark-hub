from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import time
import urllib.request
from pathlib import Path
from unittest.mock import patch

import pytest
from app.domain import remote_backup
from app.jobs import scheduler
from httpx import AsyncClient

ROOT = Path(__file__).resolve().parents[2]
FAKE_PROVIDER = ROOT / "scripts" / "fake-remote-provider-r3.mjs"
BOUNDED_RUN = Path(
    os.environ.get(
        "BOUNDED_RUN_MJS",
        ROOT / "scripts" / "lib" / "bounded-run.mjs",
    )
)


class FakeRemoteProvider:
    def __init__(self, base_url: str):
        self.base_url = base_url

    def reset(self, body: dict) -> dict:
        request = urllib.request.Request(
            f"{self.base_url}/__control/reset",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def state(self) -> dict:
        with urllib.request.urlopen(f"{self.base_url}/__control/state", timeout=3) as response:
            return json.load(response)


def _reserve_loopback_port() -> int:
    for _ in range(128):
        port = 49_152 + secrets.randbelow(65_536 - 49_152)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise RuntimeError("could not preflight an available high loopback port")


@pytest.fixture
def fake_remote_provider_r3():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required for the deterministic fake remote provider")
    port = _reserve_loopback_port()
    command = [node, str(FAKE_PROVIDER), "--host", "127.0.0.1", "--port", str(port)]
    if BOUNDED_RUN.is_file():
        # Prefer the deadline harness when available; the fixture teardown
        # below is the fallback bound when it is not installed.
        command = [
            node,
            str(BOUNDED_RUN),
            "--timeout-ms",
            "60000",
            "--kill-after-ms",
            "3000",
            "--",
            *command,
        ]
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError(f"fake provider exited early: {stdout}\n{stderr}")
        try:
            with urllib.request.urlopen(f"{base_url}/__health", timeout=0.5) as response:
                if response.status == 200:
                    break
        except OSError:
            time.sleep(0.05)
    else:
        raise AssertionError("fake provider readiness timed out")

    try:
        yield FakeRemoteProvider(base_url)
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener_check:
            listener_check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener_check.bind(("127.0.0.1", port))


def _s3_objects(count: int) -> list[dict]:
    return [
        {
            "key": f"markhub-backup/markhub-backup-2020-01-01-00-00-0{index}.json",
            "last_modified": f"2020-01-0{index}T00:00:00.000Z",
        }
        for index in range(1, count + 1)
    ]


async def _configure_s3(
    client: AsyncClient,
    auth_headers: dict,
    provider: FakeRemoteProvider,
    *,
    backup_time: str,
    keep_backups: int = 2,
) -> None:
    response = await client.put(
        "/api/v1/backup/s3",
        headers=auth_headers,
        json={
            "enabled": True,
            "endpoint": provider.base_url,
            "region": "us-east-1",
            "bucket": "markhub-test",
            "key_prefix": "markhub-backup/",
            "access_key_id": "fake-access-key",
            "secret_access_key": "fake-secret-key",
            "keep_backups": keep_backups,
            "backup_time": backup_time,
            "force_path_style": True,
        },
    )
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_fake_webdav_connection_upload_retention_partial_and_schedule(
    client: AsyncClient,
    auth_headers: dict,
    fake_remote_provider_r3: FakeRemoteProvider,
):
    provider = fake_remote_provider_r3
    response = await client.put(
        "/api/v1/backup/webdav",
        headers=auth_headers,
        json={
            "enabled": True,
            "url": provider.base_url,
            "username": "fake-user",
            "password": "fake-password",
            "path": "markhub-backup/",
            "keep_backups": 2,
            "backup_time": "12:34",
        },
    )
    assert response.status_code == 200, response.text

    response = await client.get(
        "/api/v1/backup/webdav?test=true", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True

    provider.reset(
        {
            "webdav_files": [
                "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
            ]
        }
    )
    response = await client.post("/api/v1/backup/webdav", headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.json()["retention_ok"] is True
    assert response.json()["pruned"] == 1
    assert len(provider.state()["webdav_files"]) == 2

    provider.reset(
        {
            "webdav_files": [
                "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-03.json",
            ],
            "fail_webdav_delete": [
                "markhub-backup-2020-01-01-00-00-02.json"
            ],
        }
    )
    response = await client.post("/api/v1/backup/webdav", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["retention_ok"] is False
    assert body["pruned"] == 1
    # 3 old + 1 fresh upload with keep=2 → 2 prune candidates, 1 fails
    assert body["attempted"] == 2
    assert body["failed"] == 1
    assert body["retention_error"].startswith("delete failed (1):")
    assert len(body["retention_failures"]) == 1
    assert body["retention_failures"][0]["key"].endswith(
        "markhub-backup-2020-01-01-00-00-02.json"
    )
    assert body["retention_failures"][0]["message"]
    assert len(provider.state()["webdav_files"]) == 3

    # Partial failure state persists across a refresh (MH-BACKUP-002)
    response = await client.get("/api/v1/backup/webdav", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_retention_error"].startswith("delete failed (1):")
    assert config["last_retention_error_at"] is not None
    assert config["last_retention_failed"] == 1

    provider.reset(
        {
            "webdav_files": [
                "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
            ]
        }
    )
    with patch.object(scheduler, "_local_hhmm", return_value="12:34"):
        await scheduler._run_scheduled_backups()
    state = provider.state()
    assert len(state["webdav_files"]) == 2
    assert any(
        request["provider"] == "webdav" and request["method"] == "PUT"
        for request in state["requests"]
    )

    # A fully successful run clears the persisted retention failure state
    response = await client.get("/api/v1/backup/webdav", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_retention_error"] is None
    assert config["last_retention_error_at"] is None
    assert config["last_retention_failed"] is None


@pytest.mark.asyncio
async def test_fake_s3_success_upload_failure_and_partial_delete_counts(
    client: AsyncClient,
    auth_headers: dict,
    fake_remote_provider_r3: FakeRemoteProvider,
):
    provider = fake_remote_provider_r3
    response = await client.put(
        "/api/v1/backup/s3",
        headers=auth_headers,
        json={
            "enabled": True,
            "endpoint": provider.base_url,
            "region": "us-east-1",
            "bucket": "markhub-test",
            "key_prefix": "markhub-backup/",
            "access_key_id": "fake-access-key",
            "secret_access_key": "fake-secret-key",
            "keep_backups": 2,
            "backup_time": "02:00",
            "force_path_style": True,
        },
    )
    assert response.status_code == 200, response.text

    response = await client.get("/api/v1/backup/s3?test=true", headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True

    provider.reset(
        {"bucket": "markhub-test", "s3_objects": _s3_objects(2)}
    )
    response = await client.post("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.json()["retention_ok"] is True
    assert response.json()["pruned"] == 1
    assert len(provider.state()["s3_objects"]) == 2

    provider.reset(
        {
            "bucket": "markhub-test",
            "s3_objects": _s3_objects(2),
            "fail_s3_put": True,
        }
    )
    response = await client.post("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "s3_backup_failed"
    assert len(provider.state()["s3_objects"]) == 2
    assert not any(
        request["method"] == "DELETE" for request in provider.state()["requests"]
    )

    provider.reset(
        {
            "bucket": "markhub-test",
            "s3_objects": _s3_objects(3),
            "fail_s3_delete": [
                "markhub-backup/markhub-backup-2020-01-01-00-00-02.json"
            ],
        }
    )
    response = await client.post("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["retention_ok"] is False
    assert body["pruned"] == 1
    # 3 old + 1 fresh upload with keep=2 → 2 prune candidates, 1 fails
    assert body["attempted"] == 2
    assert body["failed"] == 1
    assert body["retention_error"].startswith("delete failed (1):")
    assert [failure["key"] for failure in body["retention_failures"]] == [
        "markhub-backup/markhub-backup-2020-01-01-00-00-02.json"
    ]
    assert len(provider.state()["s3_objects"]) == 3

    response = await client.get("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_retention_error"].startswith("delete failed (1):")
    assert config["last_retention_error_at"] is not None
    assert config["last_retention_failed"] == 1


@pytest.mark.asyncio
async def test_fake_webdav_partial_retention_failure_reports_each_key(
    client: AsyncClient,
    auth_headers: dict,
    fake_remote_provider_r3: FakeRemoteProvider,
):
    """MH-BACKUP-001: >=2 failed deletes must each be identifiable, not just the last."""
    provider = fake_remote_provider_r3
    response = await client.put(
        "/api/v1/backup/webdav",
        headers=auth_headers,
        json={
            "enabled": True,
            "url": provider.base_url,
            "username": "fake-user",
            "password": "fake-password",
            "path": "markhub-backup/",
            "keep_backups": 2,
            "backup_time": "12:34",
        },
    )
    assert response.status_code == 200, response.text

    provider.reset(
        {
            "webdav_files": [
                "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-03.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-04.json",
            ],
            "fail_webdav_delete": [
                "markhub-backup-2020-01-01-00-00-01.json",
                "markhub-backup-2020-01-01-00-00-02.json",
            ],
        }
    )
    response = await client.post("/api/v1/backup/webdav", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["retention_ok"] is False
    # 4 old + 1 fresh upload with keep=2 → 3 prune candidates, 2 fail
    assert body["attempted"] == 3
    assert body["pruned"] == 1
    assert body["failed"] == 2
    assert body["retention_error"].startswith("delete failed (2):")
    assert sorted(failure["key"] for failure in body["retention_failures"]) == [
        "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
        "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
    ]
    assert all(failure["message"] for failure in body["retention_failures"])
    assert len(provider.state()["webdav_files"]) == 4

    response = await client.get("/api/v1/backup/webdav", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_retention_error"].startswith("delete failed (2):")
    assert config["last_retention_error_at"] is not None
    assert config["last_retention_failed"] == 2


@pytest.mark.asyncio
async def test_scheduled_s3_backup_runs_and_persists_state(
    client: AsyncClient,
    auth_headers: dict,
    fake_remote_provider_r3: FakeRemoteProvider,
):
    """MH-BACKUP-003a: the real scheduled entrypoint must drive S3 upload + retention."""
    provider = fake_remote_provider_r3
    await _configure_s3(client, auth_headers, provider, backup_time="12:34")
    provider.reset({"bucket": "markhub-test", "s3_objects": _s3_objects(3)})

    # The FastAPI scheduler matches backup_time against _local_hhmm() exactly
    # (it fires every minute, unlike the Worker's 15-min window), so patching
    # the single now-source is the deterministic equivalent of picking a
    # backup_time inside the current window.
    with patch.object(scheduler, "_local_hhmm", return_value="12:34"):
        await scheduler._run_scheduled_backups()

    state = provider.state()
    s3_requests = [r for r in state["requests"] if r["provider"] == "s3"]
    assert any(r["method"] == "PUT" for r in s3_requests), "scheduled PUT missing"
    assert any(r["method"] == "GET" for r in s3_requests), "retention listing missing"
    # 3 old + 1 fresh upload with keep=2 → the two oldest objects are pruned
    assert len([r for r in s3_requests if r["method"] == "DELETE"]) == 2
    assert len(state["s3_objects"]) == 2
    assert "markhub-backup/markhub-backup-2020-01-01-00-00-03.json" in state["s3_objects"]
    assert "markhub-backup/markhub-backup-2020-01-01-00-00-01.json" not in state["s3_objects"]
    assert "markhub-backup/markhub-backup-2020-01-01-00-00-02.json" not in state["s3_objects"]

    response = await client.get("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_backup_at"] is not None
    assert config["last_backup_key"] is not None
    assert config["last_backup_key"].startswith("markhub-backup/markhub-backup-")
    assert config["last_backup_key"].endswith(".json")
    assert config["last_backup_key"] in state["s3_objects"]
    assert config["last_retention_error"] is None
    assert config["last_retention_error_at"] is None
    assert config["last_retention_failed"] is None


@pytest.mark.asyncio
async def test_scheduled_s3_backup_skipped_outside_window(
    client: AsyncClient,
    auth_headers: dict,
    fake_remote_provider_r3: FakeRemoteProvider,
):
    """MH-BACKUP-003b: backup_time far from now must not trigger any backup."""
    provider = fake_remote_provider_r3
    await _configure_s3(client, auth_headers, provider, backup_time="23:45")
    provider.reset({"bucket": "markhub-test", "s3_objects": _s3_objects(3)})

    with patch.object(scheduler, "_local_hhmm", return_value="12:34"):
        await scheduler._run_scheduled_backups()

    state = provider.state()
    assert state["requests"] == []
    assert len(state["s3_objects"]) == 3

    response = await client.get("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_backup_at"] is None
    assert config["last_backup_key"] is None


@pytest.mark.asyncio
async def test_scheduled_s3_partial_retention_failure_then_clear(
    client: AsyncClient,
    auth_headers: dict,
    fake_remote_provider_r3: FakeRemoteProvider,
):
    """MH-BACKUP-001/002/003c: scheduled partial failure is structured, persisted, cleared."""
    provider = fake_remote_provider_r3
    await _configure_s3(client, auth_headers, provider, backup_time="12:34")
    failing_keys = [
        "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
        "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
    ]
    provider.reset(
        {
            "bucket": "markhub-test",
            "s3_objects": _s3_objects(4),
            "fail_s3_delete": failing_keys,
        }
    )

    # Spy on the real run so the scheduled path's structured result is visible;
    # the real scheduler entrypoint still decides whether/what to run.
    results: list[dict] = []
    real_run_s3_backup = remote_backup.run_s3_backup

    async def record_run_s3_backup(db, user_id):
        result = await real_run_s3_backup(db, user_id)
        results.append(result)
        return result

    with (
        patch.object(remote_backup, "run_s3_backup", new=record_run_s3_backup),
        patch.object(scheduler, "_local_hhmm", return_value="12:34"),
    ):
        await scheduler._run_scheduled_backups()

    assert len(results) == 1, "scheduled S3 backup did not run"
    result = results[0]
    assert result["ok"] is True
    assert result["retention_ok"] is False
    # 4 old + 1 fresh upload with keep=2 → 3 prune candidates, 2 fail
    assert result["attempted"] == 3
    assert result["pruned"] == 1
    assert result["failed"] == len(failing_keys)
    assert result["retention_error"].startswith("delete failed (2):")
    assert sorted(failure["key"] for failure in result["retention_failures"]) == failing_keys
    assert all(failure["message"] for failure in result["retention_failures"])
    assert len(provider.state()["s3_objects"]) == 4

    response = await client.get("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_retention_error"].startswith("delete failed (2):")
    assert config["last_retention_error_at"] is not None
    assert config["last_retention_failed"] == 2
    assert config["last_backup_at"] is not None
    assert config["last_backup_key"] == result["key"]

    # A fully successful scheduled run clears the persisted failure state
    provider.reset({"bucket": "markhub-test", "s3_objects": _s3_objects(2)})
    with patch.object(scheduler, "_local_hhmm", return_value="12:34"):
        await scheduler._run_scheduled_backups()
    assert len(provider.state()["s3_objects"]) == 2

    response = await client.get("/api/v1/backup/s3", headers=auth_headers)
    assert response.status_code == 200, response.text
    config = response.json()
    assert config["last_retention_error"] is None
    assert config["last_retention_error_at"] is None
    assert config["last_retention_failed"] is None


def test_retention_failures_list_capped_with_accurate_counts():
    """Contract: retention_failures caps at 20 entries while counts stay accurate."""
    failures = [{"key": f"k{index}", "message": f"m{index}"} for index in range(25)]
    result = remote_backup._retention_result(
        pruned=5, attempted=30, failures=failures, list_error=None
    )
    assert result["retention_ok"] is False
    assert result["attempted"] == 30
    assert result["failed"] == 25
    assert len(result["retention_failures"]) == remote_backup.RETENTION_FAILURES_CAP == 20
    assert result["retention_error"] == "delete failed (25): m0"
