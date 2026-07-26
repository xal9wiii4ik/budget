"""Application settings.

Single source of configuration. Imports nothing internal (see architecture §1
dependency direction). ``get_settings`` is the canonical accessor used by
``create_app``'s default and ``alembic/env.py``; tests construct ``Settings``
explicitly and never touch the cache.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    # Required, no default: fail fast if JWT_SECRET is missing from the env. Signs
    # access JWTs and (reused for single-secret simplicity) reset-password tokens.
    jwt_secret: str

    # Token lifetimes. Kept as fields (not surfaced in .env.example) so tests can
    # shrink them; code defaults are the production values.
    access_token_lifetime_seconds: int = 900  # ~15 min
    refresh_token_lifetime_seconds: int = 2_592_000  # 30 days

    # Browser origins allowed by CORS (architecture §3: "CORS — только домены
    # приложения"). Default is the vite dev server so the known explicit
    # Settings(...) construction sites (openapi_export, tests, test_health) need no
    # new env. Override in deploy (1.7) via the CORS_ORIGINS env var, which
    # pydantic-settings parses as a JSON array of strings, e.g.
    # CORS_ORIGINS='["https://app.example.com","https://www.example.com"]'.
    cors_origins: list[str] = ["http://localhost:5173"]

    # Rate limiting. Per-app knobs read at request time so the multi-app test
    # pattern can enable/disable and shrink limits per app instance.
    rate_limit_enabled: bool = True
    login_rate_limit: str = "10/minute"
    register_rate_limit: str = "5/hour"
    forgot_password_rate_limit: str = "5/hour"
    # Per-user receipt-create limit (D11): the account is the cost driver, not the
    # localhost IP, so this keys on user id (see rate_limit.receipt_rl_key).
    receipt_create_rate_limit: str = "30/minute"

    # Object storage (D9/D11). Defaults target the local MinIO from docker-compose
    # (host ports 9010 S3 / 9011 console, private bucket ``receipts``). Every field
    # has a default so the explicit Settings(...) sites (openapi_export, conftest)
    # keep constructing with no S3 env. s3_endpoint_url is a full URL; Storage
    # splits scheme->secure and netloc->endpoint for minio-py.
    s3_endpoint_url: str = "http://localhost:9010"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "receipts"
    s3_region: str = "us-east-1"
    s3_presign_put_ttl_seconds: int = 600
    s3_presign_get_ttl_seconds: int = 300

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # database_url/jwt_secret from env/.env
