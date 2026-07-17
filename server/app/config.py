import os
import sys
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Known insecure defaults that must never be accepted in production (F-011)
_INSECURE_JWT = {
    "change-me",
    "change-me-jwt-secret",
    "secret",
    "jwt-secret",
    "",
}
_INSECURE_MASTER = {
    "change-me-master-key-32bytes!!!!",
    "change-me",
    "change-me-master-key",
    "",
}
_INSECURE_ADMIN_PASSWORDS = {
    "admin",
    "admin123",
    "password",
    "123456",
    "",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "MarkHub API"
    debug: bool = False
    version: str = "0.1.0"

    database_url: str = "sqlite+aiosqlite:///./data/markhub.db"

    jwt_secret: str = ""
    jwt_algorithm: str = "HS256"
    jwt_expire_days: int = 7

    markhub_master_key: str = ""

    cors_origins: str = "*"

    default_admin_username: str = "admin"
    default_admin_password: str = ""
    force_admin_password_change: bool = True

    # Feature flags
    ff_webdav: bool = True
    ff_s3_backup: bool = True
    ff_public_nav: bool = True

    # Allow insecure defaults only for automated tests
    allow_insecure_defaults: bool = False

    # Seed prototype demo folders/bookmarks on first empty bootstrap
    seed_demo_data: bool = True


def _is_strong_secret(value: str, *, min_len: int = 16) -> bool:
    return bool(value) and len(value) >= min_len


def validate_security_settings(settings: Settings) -> list[str]:
    """Return list of security configuration problems (F-011)."""
    errors: list[str] = []
    if settings.allow_insecure_defaults:
        return errors
    # pytest / explicit test env
    if os.environ.get("MARKHUB_TESTING") == "1" or os.environ.get("PYTEST_CURRENT_TEST"):
        return errors

    jwt = (settings.jwt_secret or "").strip()
    if jwt in _INSECURE_JWT or not _is_strong_secret(jwt):
        errors.append(
            "JWT_SECRET must be a strong secret (>=16 chars) and not a known default"
        )
    master = (settings.markhub_master_key or "").strip()
    if master in _INSECURE_MASTER or not _is_strong_secret(master, min_len=24):
        errors.append(
            "MARKHUB_MASTER_KEY must be a strong secret (>=24 chars) and not a known default"
        )
    # Admin password only checked when bootstrapping would use it — still flag weak defaults
    admin_pw = (settings.default_admin_password or "").strip()
    if admin_pw in _INSECURE_ADMIN_PASSWORDS:
        errors.append(
            "DEFAULT_ADMIN_PASSWORD must not be a known weak default (admin123/password/…)"
        )
    return errors


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    # Auto-enable insecure for unit tests
    if os.environ.get("PYTEST_CURRENT_TEST") or os.environ.get("MARKHUB_TESTING") == "1":
        object.__setattr__(s, "allow_insecure_defaults", True)
        if not s.jwt_secret:
            object.__setattr__(s, "jwt_secret", "test-jwt-secret-value-xx")
        if not s.markhub_master_key:
            object.__setattr__(s, "markhub_master_key", "test-master-key-32-bytes-long!!")
        if not s.default_admin_password:
            object.__setattr__(s, "default_admin_password", "admin123")
    return s


def assert_secure_or_exit() -> None:
    settings = get_settings()
    problems = validate_security_settings(settings)
    if problems:
        for p in problems:
            print(f"FATAL: {p}", file=sys.stderr)
        print(
            "Refusing to start with insecure configuration. "
            "Generate strong JWT_SECRET and MARKHUB_MASTER_KEY, "
            "and set a unique DEFAULT_ADMIN_PASSWORD.",
            file=sys.stderr,
        )
        raise SystemExit(1)
