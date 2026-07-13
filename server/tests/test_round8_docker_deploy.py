"""Regression tests for deployment-and-documentation findings (round 3).

Findings:
  RQG-DOCKER-DEPLOY-001  — documented Compose paths must be runnable with secrets setup
  RQG-DOCKER-POSTGRES-001 — Postgres must not ship weak defaults or publish 5432
  RQG-DOCKER-001         — image must not bake secrets; build context must exclude local state
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "docker-compose.yml"
DOCKERFILE = ROOT / "docker" / "Dockerfile"
DOCKERIGNORE = ROOT / ".dockerignore"
ENV_EXAMPLE = ROOT / ".env.example"
README = ROOT / "README.md"
GEN_ENV = ROOT / "scripts" / "generate-docker-env.sh"
INTEGRATION_COMPOSE = ROOT / "docker" / "docker-compose.integration.yml"
INTEGRATION_RUNNER = ROOT / "scripts" / "test-docker-deploy.sh"


def _load_compose() -> dict:
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


def test_rqg_docker_001_dockerignore_excludes_secrets_and_local_state():
    """RQG-DOCKER-001: restrictive .dockerignore must exist and block sensitive paths."""
    assert DOCKERIGNORE.is_file(), "missing .dockerignore at repo root"
    text = DOCKERIGNORE.read_text(encoding="utf-8")
    # Core exclusions that prevent packaging local secrets / venvs / data
    for needle in (".env", ".venv", "server/.venv", "server/data", "__pycache__", "node_modules"):
        assert needle in text, f".dockerignore must exclude {needle!r}"
    # Must not be an allow-everything file
    assert len(text.strip().splitlines()) >= 8


def test_rqg_docker_001_dockerfile_has_no_secret_env_defaults():
    """RQG-DOCKER-001: Dockerfile must not declare insecure secret ENV defaults."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    # Forbidden insecure defaults previously shipped in the image
    forbidden = [
        "JWT_SECRET=change-me",
        "MARKHUB_MASTER_KEY=change-me",
        "DEFAULT_ADMIN_PASSWORD=admin123",
        "ENV JWT_SECRET=",
        "ENV MARKHUB_MASTER_KEY=",
        "ENV DEFAULT_ADMIN_PASSWORD=",
    ]
    for bad in forbidden:
        assert bad not in text, f"Dockerfile must not set secret default: {bad!r}"

    # Must copy application sources selectively (not the entire local server tree)
    assert "COPY server/app" in text
    assert re.search(r"^COPY server\s+/app/server\s*$", text, re.M) is None, (
        "Dockerfile must not COPY the entire server/ tree (would include tests/venvs/data)"
    )


def test_rqg_docker_001_dockerfile_copies_only_runtime_sources():
    """RQG-DOCKER-001: runtime stage lists only required server artefacts."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY server/requirements.txt" in text
    assert "COPY server/migrations" in text
    # Tests must not be copied into the image
    assert "COPY server/tests" not in text


def test_rqg_docker_postgres_001_password_required_and_interpolated():
    """RQG-DOCKER-POSTGRES-001: one required password, no hard-coded markhub, no host 5432."""
    raw = COMPOSE.read_text(encoding="utf-8")
    data = _load_compose()

    postgres = data["services"]["postgres"]
    markhub_pg = data["services"]["markhub-pg"]

    # Password must come from required env substitution, not a literal "markhub"
    pg_env = postgres.get("environment") or {}
    assert "POSTGRES_PASSWORD" in pg_env
    pw = str(pg_env["POSTGRES_PASSWORD"])
    assert "markhub" not in pw.lower() or "POSTGRES_PASSWORD" in pw
    assert "${POSTGRES_PASSWORD" in pw or "POSTGRES_PASSWORD" in raw
    assert re.search(r"POSTGRES_PASSWORD:\s*markhub\b", raw) is None
    assert "postgresql+asyncpg://markhub:markhub@" not in raw

    # App DATABASE_URL must interpolate the same password variable
    app_env = markhub_pg.get("environment") or {}
    db_url = str(app_env.get("DATABASE_URL", ""))
    assert "${POSTGRES_PASSWORD" in db_url or "POSTGRES_PASSWORD" in db_url
    assert "@postgres:5432" in db_url

    # Database must stay internal — no host port publish
    ports = postgres.get("ports") or []
    assert ports == [], f"postgres must not publish host ports, got {ports}"
    assert '"5432:5432"' not in raw
    assert re.search(r'^\s*-\s*"?5432:5432"?\s*$', raw, re.M) is None


def test_rqg_docker_deploy_001_postgres_profile_includes_database():
    """RQG-DOCKER-DEPLOY-001: postgres-app profile must include the postgres service."""
    data = _load_compose()
    postgres = data["services"]["postgres"]
    markhub_pg = data["services"]["markhub-pg"]

    pg_profiles = set(postgres.get("profiles") or [])
    app_profiles = set(markhub_pg.get("profiles") or [])

    assert "postgres-app" in pg_profiles, (
        "postgres service must join postgres-app so markhub-pg dependency resolves"
    )
    assert "postgres-app" in app_profiles
    assert "postgres" in (markhub_pg.get("depends_on") or {})


def test_rqg_docker_deploy_001_docs_require_env_before_quickstart():
    """RQG-DOCKER-DEPLOY-001: README must establish secrets before compose up."""
    text = README.read_text(encoding="utf-8")
    docker_section = text.split("## Docker", 1)[1].split("## Cloudflare", 1)[0]
    assert ".env" in docker_section or "generate-docker-env" in docker_section
    assert "JWT_SECRET" in docker_section
    assert "MARKHUB_MASTER_KEY" in docker_section
    assert "DEFAULT_ADMIN_PASSWORD" in docker_section
    # Documented quick start still present
    assert "docker compose up --build" in docker_section
    # Postgres path documents profile + POSTGRES_PASSWORD
    assert "postgres-app" in docker_section
    assert "POSTGRES_PASSWORD" in docker_section

    assert ENV_EXAMPLE.is_file(), "missing .env.example for clean checkout"
    example = ENV_EXAMPLE.read_text(encoding="utf-8")
    for key in ("JWT_SECRET", "MARKHUB_MASTER_KEY", "DEFAULT_ADMIN_PASSWORD", "POSTGRES_PASSWORD"):
        assert key in example

    assert GEN_ENV.is_file()
    assert os.access(GEN_ENV, os.X_OK), "generate-docker-env.sh must be executable"


def _compose_env_clean() -> dict[str, str]:
    """Environment with MarkHub secrets stripped (simulates clean checkout)."""
    env = {k: v for k, v in os.environ.items() if k not in {
        "JWT_SECRET",
        "MARKHUB_MASTER_KEY",
        "DEFAULT_ADMIN_PASSWORD",
        "POSTGRES_PASSWORD",
        "POSTGRES_USER",
        "POSTGRES_DB",
        "DATABASE_URL",
    }}
    # Prevent accidental .env pickup from the developer's shell cwd alone —
    # compose still loads project `.env` if present; tests assert file templates instead
    # when that happens. We still run config with explicit env for positive cases.
    return env


def _run_compose(args: list[str], *, env: dict[str, str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "compose", *args],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.mark.skipif(
    subprocess.run(["docker", "compose", "version"], capture_output=True).returncode != 0,
    reason="docker compose CLI not available",
)
def test_rqg_docker_deploy_001_compose_config_requires_secrets_without_env_file(tmp_path: Path):
    """Documented clean-checkout failure mode: no secrets → compose config fails."""
    # Isolate from any developer .env in the real repo by copying compose into tmp
    (tmp_path / "docker-compose.yml").write_text(COMPOSE.read_text(encoding="utf-8"), encoding="utf-8")
    # Minimal build context placeholders so compose parse does not need the monorepo
    (tmp_path / "docker").mkdir()
    (tmp_path / "docker" / "Dockerfile").write_text("# stub\n", encoding="utf-8")

    env = _compose_env_clean()
    # Ensure no leftover compose project env
    env.pop("COMPOSE_FILE", None)

    proc = _run_compose(["config", "--quiet"], env=env, cwd=tmp_path)
    assert proc.returncode != 0, "compose must refuse to start without required secrets"
    combined = (proc.stdout or "") + (proc.stderr or "")
    assert "JWT_SECRET" in combined or "required" in combined.lower()


@pytest.mark.skipif(
    subprocess.run(["docker", "compose", "version"], capture_output=True).returncode != 0,
    reason="docker compose CLI not available",
)
def test_rqg_docker_deploy_001_compose_config_succeeds_with_secrets(tmp_path: Path):
    """With required secrets, default SQLite service config validates."""
    (tmp_path / "docker-compose.yml").write_text(COMPOSE.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "docker").mkdir()
    (tmp_path / "docker" / "Dockerfile").write_text("# stub\n", encoding="utf-8")

    env = _compose_env_clean()
    env.update(
        {
            "JWT_SECRET": "unit-test-jwt-secret-value-xx",
            "MARKHUB_MASTER_KEY": "unit-test-master-key-32bytes!!!!",
            "DEFAULT_ADMIN_PASSWORD": "UnitTestAdminPass99!",
            # Compose interpolates profiled services even when inactive, so the
            # shared .env always carries POSTGRES_PASSWORD (generator + example).
            "POSTGRES_PASSWORD": "UnitTestPgPass99Strong",
        }
    )
    proc = _run_compose(["config", "--quiet"], env=env, cwd=tmp_path)
    assert proc.returncode == 0, proc.stderr or proc.stdout


@pytest.mark.skipif(
    subprocess.run(["docker", "compose", "version"], capture_output=True).returncode != 0,
    reason="docker compose CLI not available",
)
def test_rqg_docker_deploy_001_postgres_app_profile_resolves_and_needs_db_password(tmp_path: Path):
    """postgres-app profile is a valid Compose project and requires POSTGRES_PASSWORD."""
    (tmp_path / "docker-compose.yml").write_text(COMPOSE.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "docker").mkdir()
    (tmp_path / "docker" / "Dockerfile").write_text("# stub\n", encoding="utf-8")

    base = _compose_env_clean()
    base.update(
        {
            "JWT_SECRET": "unit-test-jwt-secret-value-xx",
            "MARKHUB_MASTER_KEY": "unit-test-master-key-32bytes!!!!",
            "DEFAULT_ADMIN_PASSWORD": "UnitTestAdminPass99!",
        }
    )

    # Missing POSTGRES_PASSWORD → fail (RQG-DOCKER-POSTGRES-001)
    missing = _run_compose(
        ["--profile", "postgres-app", "config", "--services"],
        env=base,
        cwd=tmp_path,
    )
    assert missing.returncode != 0
    assert "POSTGRES_PASSWORD" in ((missing.stdout or "") + (missing.stderr or ""))

    # With password → valid project listing both services
    ok_env = {**base, "POSTGRES_PASSWORD": "UnitTestPgPass99Strong"}
    ok = _run_compose(
        ["--profile", "postgres-app", "config", "--services"],
        env=ok_env,
        cwd=tmp_path,
    )
    assert ok.returncode == 0, ok.stderr or ok.stdout
    services = set((ok.stdout or "").split())
    assert "postgres" in services, f"postgres must be selected with postgres-app, got {services}"
    assert "markhub-pg" in services

    # Rendered config must not expose host 5432 and must embed the password in DATABASE_URL
    rendered = _run_compose(
        ["--profile", "postgres-app", "config"],
        env=ok_env,
        cwd=tmp_path,
    )
    assert rendered.returncode == 0, rendered.stderr
    cfg = yaml.safe_load(rendered.stdout)
    pg = cfg["services"]["postgres"]
    assert not pg.get("ports"), "rendered postgres service must not publish ports"
    assert pg["environment"]["POSTGRES_PASSWORD"] == "UnitTestPgPass99Strong"
    app_url = cfg["services"]["markhub-pg"]["environment"]["DATABASE_URL"]
    assert "UnitTestPgPass99Strong" in app_url
    assert "markhub:markhub@" not in app_url


def test_dockerfile_and_compose_agree_on_no_insecure_image_defaults():
    """Cross-check: image + compose both force runtime secrets (shared boundary)."""
    df = DOCKERFILE.read_text(encoding="utf-8")
    compose = COMPOSE.read_text(encoding="utf-8")
    assert "admin123" not in df
    assert re.search(r"POSTGRES_PASSWORD:\s*markhub\b", compose) is None
    # compose requires the three app secrets
    for key in ("JWT_SECRET", "MARKHUB_MASTER_KEY", "DEFAULT_ADMIN_PASSWORD"):
        assert f"{key}: ${{{key}:?" in compose or f"{key}: ${{{key}:" in compose


def test_rqg_f010_f011_owned_runtime_harness_is_checked_in():
    """The release harness owns ports, Compose resources, persistence, and cleanup."""
    assert INTEGRATION_COMPOSE.is_file()
    assert INTEGRATION_RUNNER.is_file()
    assert os.access(INTEGRATION_RUNNER, os.X_OK)

    runner = INTEGRATION_RUNNER.read_text(encoding="utf-8")
    for evidence in (
        "bounded-run.mjs",
        "--timeout-ms 900000",
        "--project-name",
        "assert_unbound",
        "compose down --volumes --remove-orphans",
        "compose restart",
        "pnpm exec playwright test",
        "sqlite-persist-",
        "postgres-persist-",
        "markhub_legacy",
        "schema_migrations",
        "bad-fk",
    ):
        assert evidence in runner

    cfg = yaml.safe_load(INTEGRATION_COMPOSE.read_text(encoding="utf-8"))
    services = cfg["services"]
    assert set(
        ("markhub-sqlite", "postgres", "markhub-postgres", "markhub-postgres-legacy")
    ) <= set(services)
    assert services["markhub-sqlite"]["ports"] == [
        "127.0.0.1:${MARKHUB_SQLITE_PORT}:8000"
    ]
    assert services["markhub-postgres"]["ports"] == [
        "127.0.0.1:${MARKHUB_POSTGRES_PORT}:8000"
    ]
