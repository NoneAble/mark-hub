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
from app.jobs import scheduler
from httpx import AsyncClient

ROOT = Path(__file__).resolve().parents[2]
FAKE_PROVIDER = ROOT / "scripts" / "fake-remote-provider-r3.mjs"
BOUNDED_RUN = Path(
    os.environ.get(
        "BOUNDED_RUN_MJS",
        Path.home() / ".pi/agent/extensions/trio-workflow/bounded-run.mjs",
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
    if not BOUNDED_RUN.is_file():
        pytest.skip(f"bounded-run helper is required: {BOUNDED_RUN}")
    port = _reserve_loopback_port()
    process = subprocess.Popen(
        [
            node,
            str(BOUNDED_RUN),
            "--timeout-ms",
            "60000",
            "--kill-after-ms",
            "3000",
            "--",
            node,
            str(FAKE_PROVIDER),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
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
    assert response.json()["retention_ok"] is False
    assert response.json()["pruned"] == 1
    assert "delete failed" in response.json()["retention_error"]
    assert len(provider.state()["webdav_files"]) == 3

    provider.reset(
        {
            "webdav_files": [
                "markhub-backup/markhub-backup-2020-01-01-00-00-01.json",
                "markhub-backup/markhub-backup-2020-01-01-00-00-02.json",
            ]
        }
    )
    with (
        patch.object(scheduler, "_local_hhmm", return_value="12:34"),
        patch.object(scheduler, "_local_minute", return_value=1),
    ):
        await scheduler._run_scheduled_backups()
    state = provider.state()
    assert len(state["webdav_files"]) == 2
    assert any(
        request["provider"] == "webdav" and request["method"] == "PUT"
        for request in state["requests"]
    )


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
    assert response.json()["retention_ok"] is False
    assert response.json()["pruned"] == 1
    assert "delete failed" in response.json()["retention_error"]
    assert len(provider.state()["s3_objects"]) == 3
