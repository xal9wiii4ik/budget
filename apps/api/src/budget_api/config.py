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

    # Anthropic parse pipeline (D10/D11). ``anthropic_api_key`` defaults to "" so the
    # explicit Settings(...) sites (openapi_export, conftest) keep constructing with
    # no key; the handler turns an empty key into a fast 503 AI_NOT_CONFIGURED rather
    # than a background failure. ``anthropic_model`` is pinned to the dated Haiku 4.5
    # snapshot (anthropic SDK 0.120.0 anthropic.types.model listing) for
    # reproducibility; swap to Sonnet via env if quality demands (open Q4 default).
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"
    receipt_parse_timeout_seconds: int = 90
    # Staleness cutoff for re-claiming a stuck ``processing`` receipt. Kept strictly
    # greater than the parse timeout so a live parse can never be double-claimed.
    receipt_parse_stale_seconds: int = 300
    # Parse-time HEAD size gate. Kept safely under Anthropic's ~5 MB per-image API
    # limit (5_000_000, not 5 MiB, to dodge MB-vs-MiB ambiguity): a larger upload
    # would sail past this 422 gate, claim the row, spend the metered pipeline, and
    # come back as ``failed / ANTHROPIC_ERROR`` — a *permanent* condition mislabeled
    # as transient, sending the client into the wrong (just-re-POST) retry branch
    # instead of the IMAGE_TOO_LARGE "restart from downscale" path.
    receipt_max_bytes: int = 5_000_000
    # Per-user parse limit (D11): each parse is an Anthropic spend, so the account is
    # the cost driver. Keys on user id via rate_limit.receipt_rl_key.
    receipt_parse_rate_limit: str = "10/minute;100/day"

    # FX rates (D1/D3/D4). Every field has a default so the explicit Settings(...)
    # sites (openapi_export, conftest) keep constructing with no FX env.
    # ``fx_scheduler_enabled`` is the D3 gate: the whole pytest suite constructs apps
    # with it False (conftest), so no test ever spawns a background job or makes a
    # provider call; the one real fetch happens live at /test.
    fx_scheduler_enabled: bool = True
    # Daily cron slot: both providers have published by 17:30 UTC on business days
    # (ECB ~16:00 CET, NBRB in the Minsk afternoon) and the nearest-previous lookup
    # absorbs any lag anyway (D2/D3).
    fx_fetch_hour_utc: int = 17
    fx_fetch_minute_utc: int = 30
    # One-shot history depth when a provider has no rows at all (D4, OQ-3 default):
    # "a year ago" plus lookup slack, so pre-existing transactions convert on day one.
    fx_backfill_days: int = 400
    fx_http_timeout_seconds: int = 30
    # Provider base URLs as settings so a live session can point at a local stub.
    frankfurter_base_url: str = "https://api.frankfurter.app"
    nbrb_base_url: str = "https://api.nbrb.by"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # database_url/jwt_secret from env/.env
