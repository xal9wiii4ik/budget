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

    # Rate limiting. Per-app knobs read at request time so the multi-app test
    # pattern can enable/disable and shrink limits per app instance.
    rate_limit_enabled: bool = True
    login_rate_limit: str = "10/minute"
    register_rate_limit: str = "5/hour"
    forgot_password_rate_limit: str = "5/hour"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # database_url/jwt_secret from env/.env
