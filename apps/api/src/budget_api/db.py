"""Async SQLAlchemy engine, sessionmaker, and request-scoped session dependency.

Depends only on ``config`` (see architecture §1). The engine and sessionmaker are
built in the app lifespan and stored on ``app.state``; ``get_session`` reads the
sessionmaker from there so each app instance uses its own engine on its own loop.
"""

from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from budget_api.config import Settings


def build_engine(settings: Settings) -> AsyncEngine:
    # connect_args timeout bounds asyncpg's 60s connect default so a down DB
    # fails fast; the health endpoint's asyncio.wait_for is belt-and-suspenders.
    return create_async_engine(settings.database_url, connect_args={"timeout": 2})


def build_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with sessionmaker() as session:
        yield session
