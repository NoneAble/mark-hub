"""Optional live dual-runtime parity runner (F-010 / R4-F003).

Skip unless MARKHUB_PARITY_BASE_URL is set. Uses env credentials so secure
deployments (non-default admin passwords) work unchanged.
"""

from __future__ import annotations

import os
import re

import pytest
from httpx import AsyncClient
from tests.parity_fixtures import (
    PARITY_CASES,
    PARITY_PASSWORD,
    PARITY_STATEFUL_STEPS,
    PARITY_USERNAME,
)

BASE = os.environ.get("MARKHUB_PARITY_BASE_URL")


def _resolve(value, ctx: dict):
    if isinstance(value, str) and value.startswith("$"):
        return ctx.get(value[1:], value)
    if isinstance(value, str) and "$" in value:
        def repl(m):
            return str(ctx.get(m.group(1), m.group(0)))

        return re.sub(r"\$([a-zA-Z_][a-zA-Z0-9_]*)", repl, value)
    if isinstance(value, list):
        return [_resolve(v, ctx) for v in value]
    if isinstance(value, dict):
        return {k: _resolve(v, ctx) for k, v in value.items()}
    return value


async def _login(client: AsyncClient) -> str:
    user = PARITY_USERNAME
    password = PARITY_PASSWORD
    login = await client.post(
        "/api/v1/auth/login",
        json={"username": user, "password": password},
    )
    if login.status_code != 200:
        # Common test fallback after force-change
        alt = os.environ.get("MARKHUB_NEW_PASSWORD", "admin1234")
        login = await client.post(
            "/api/v1/auth/login",
            json={"username": user, "password": alt},
        )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    if login.json().get("must_change_password"):
        new_pass = os.environ.get("MARKHUB_NEW_PASSWORD", "ParityAdminPass99!")
        await client.put(
            "/api/v1/auth/credentials",
            headers={"Authorization": f"Bearer {token}"},
            json={"current_password": password, "new_password": new_pass},
        )
        login = await client.post(
            "/api/v1/auth/login",
            json={"username": user, "password": new_pass},
        )
        assert login.status_code == 200, login.text
        token = login.json()["access_token"]
    return token


@pytest.mark.asyncio
async def test_live_parity_suite():
    if not BASE:
        pytest.skip("MARKHUB_PARITY_BASE_URL not set")
    async with AsyncClient(base_url=BASE.rstrip("/"), timeout=30.0) as client:
        token = None
        for case in PARITY_CASES:
            headers = {}
            if case.get("auth"):
                if not token:
                    token = await _login(client)
                headers["Authorization"] = f"Bearer {token}"
            method = case["method"].lower()
            kwargs: dict = {"headers": headers}
            if "json" in case:
                kwargs["json"] = case["json"]
            r = await getattr(client, method)(case["path"], **kwargs)
            assert r.status_code == case["status"], f"{case['id']}: {r.status_code} {r.text}"
            for k in case.get("json_keys") or []:
                body = r.json()
                assert k in body, f"{case['id']}: missing key {k} in {body}"


@pytest.mark.asyncio
async def test_live_parity_stateful():
    if not BASE:
        pytest.skip("MARKHUB_PARITY_BASE_URL not set")
    async with AsyncClient(base_url=BASE.rstrip("/"), timeout=30.0) as client:
        token = await _login(client)
        headers = {"Authorization": f"Bearer {token}"}
        ctx: dict = {}
        for step in PARITY_STATEFUL_STEPS:
            method = step["method"].lower()
            path = _resolve(step.get("path_from") or step["path"], ctx)
            kwargs: dict = {"headers": headers}
            body = step.get("json_from") or step.get("json")
            if body is not None:
                kwargs["json"] = _resolve(body, ctx)
            r = await getattr(client, method)(path, **kwargs)
            allowed = step.get("status_in") or [step.get("status", 200)]
            assert r.status_code in allowed, f"{step['id']}: {r.status_code} {r.text}"
            if r.status_code < 400:
                data = r.json()
                for k in step.get("json_keys") or []:
                    assert k in data, f"{step['id']}: missing {k}"
                for dest, src in (step.get("save") or {}).items():
                    ctx[dest] = data.get(src)
