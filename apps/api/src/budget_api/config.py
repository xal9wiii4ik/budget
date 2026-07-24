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

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from env/.env
